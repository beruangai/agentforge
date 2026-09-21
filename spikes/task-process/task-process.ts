/**
 * The task process side of the task protocol (ADR 0004).
 *
 * Speaks JSON-RPC 2.0, one message per line, over a DEDICATED socketpair on
 * fd 3 — never stdout, which carries the task's own logs. Opens with a protocol
 * version both sides must accept.
 *
 * Argv:
 *   --behaviour  what the "run" does
 *   --version    the protocol version this process claims
 *   --load-sdk   import the Agent SDK before handshaking, to measure its cost
 */
import net from 'node:net';

const argv = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [k, v = 'true'] = arg.replace(/^--/, '').split('=');
  argv.set(k!, v);
}

const PROTOCOL_VERSION = argv.get('version') ?? '1';
const behaviour = argv.get('behaviour') ?? 'quick';
const processStartedAt = Number(argv.get('spawned-at') ?? Date.now());

// Module-load cost is measured from the caller's spawn instant to here.
const moduleLoadedAt = Date.now();

let sdkLoadedAt = moduleLoadedAt;
if (argv.get('load-sdk') === 'true') {
  await import('@anthropic-ai/claude-agent-sdk');
  sdkLoadedAt = Date.now();
}

const channel = net.connect({ fd: 3 } as any);

function send(message: unknown) {
  channel.write(JSON.stringify(message) + '\n');
}

/** Whatever the "run" does; a real one would be an agent query. */
async function run(): Promise<Record<string, unknown>> {
  switch (behaviour) {
    case 'quick':
      // Noise on stdout, including a line that LOOKS like protocol traffic.
      // If the two shared a channel, this would corrupt the executor's parse.
      console.log('a log line from the task');
      console.log(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { outcome: 'SABOTAGE' } }));
      console.error('and one on stderr');
      return { ok: true };

    case 'long':
      // Long enough to be cancelled mid-run.
      for (let i = 0; i < 600; i += 1) {
        if (cancelRequested) break;
        send({ jsonrpc: '2.0', method: 'event', params: { sequence: i, kind: 'progress' } });
        await Bun.sleep(100);
      }
      return { ok: true, cancelled: cancelRequested };

    case 'spawns-grandchild': {
      // A grandchild that outlives its parent unless the whole GROUP is killed.
      // It writes a marker every 200ms, so survival is observable from outside.
      const marker = argv.get('marker')!;
      Bun.spawn(['bash', '-c', `while true; do date +%s%3N >> ${marker}; sleep 0.2; done`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await Bun.sleep(60_000);
      return { ok: true };
    }

    case 'ignores-sigterm':
      // The handler is installed at the top level instead, so it genuinely
      // replaces the default disposition. SIGKILL is then the only way out.
      await Bun.sleep(60_000);
      return { ok: true };

    case 'cpu-burn': {
      // Saturates its own core, to show a task cannot stall the executor's
      // event loop and get a busy session reaped (D31).
      const until = Date.now() + Number(argv.get('ms') ?? 5_000);
      while (Date.now() < until) {
        // Intentionally blocking: this is the hostile case.
        Math.sqrt(Math.random());
      }
      return { ok: true };
    }

    default:
      throw new Error(`unknown behaviour ${behaviour}`);
  }
}

let cancelRequested = false;

channel.on('data', async (chunk: Buffer) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);

    if (message.method === 'hello') {
      // The version handshake: both sides must accept, before any work.
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          pid: process.pid,
          processGroupId: process.pid,
          spawnToModuleLoadedMs: moduleLoadedAt - processStartedAt,
          spawnToReadyMs: Date.now() - processStartedAt,
          sdkLoadMs: sdkLoadedAt - moduleLoadedAt,
        },
      });
      continue;
    }

    if (message.method === 'run') {
      try {
        const outcome = await run();
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'SUCCEEDED', ...outcome } });
      } catch (error) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: String(error) } });
      }
      continue;
    }

    if (message.method === 'cancel') {
      cancelRequested = true;
      send({ jsonrpc: '2.0', id: message.id, result: { acknowledged: true } });
      continue;
    }
  }
});

if (behaviour === 'ignores-sigterm') {
  // A handler that does nothing still REPLACES the default disposition, so the
  // process survives SIGTERM entirely. This is the hostile case the grace
  // period exists for: a task wedged in an uninterruptible loop, or one whose
  // shutdown path is itself broken.
  process.on('SIGTERM', () => {});
} else {
  // Graceful stop: record CANCELLED, flush, exit inside the grace period.
  process.on('SIGTERM', () => {
    cancelRequested = true;
    send({ jsonrpc: '2.0', method: 'event', params: { kind: 'sigterm-received', at: Date.now() } });
    setTimeout(() => process.exit(0), 50);
  });
}

// Keep the process alive on the channel alone.
channel.on('close', () => process.exit(0));
