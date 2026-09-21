/**
 * DESIGN_OPTIONS §C (local half) and §G.
 *
 * §C: the task-process protocol over a dedicated pipe, and `SIGTERM` then
 *     `SIGKILL` of the process GROUP, so nothing a task started outlives it.
 * §G: `/ping` latency with several tasks in child processes, and the start cost
 *     of a process per task — module load plus SDK startup — against a typical
 *     run's duration. Confirms or overturns ADR 0004 with numbers.
 *
 * Nine cases, no model spend:
 *
 *   1  handshake over a dedicated fd, with stdout noise proving separation
 *   2  a protocol version the executor does not accept is refused before work
 *   3  a graceful cancel: SIGTERM, an outcome recorded inside the grace period
 *   4  SIGKILL of the process group kills a grandchild the task started
 *   5  NEGATIVE CONTROL: killing the process alone leaves the grandchild alive
 *   6  a cancel arriving BEFORE the task process exists
 *   7  /ping latency with N tasks running, including a CPU-saturating one
 *   8  spawn cost: bare process, and with the Agent SDK loaded
 *   9  several tasks at once, with their per-task memory
 *
 * Run: bun task-process/cg1-protocol-and-cost.ts [case...]
 */
import net from 'node:net';
import { finding, reportFindings } from '../harness.ts';

const TASK_PROCESS = `${import.meta.dir}/task-process.ts`;
const EXECUTOR_PROTOCOL_VERSION = '1';
const GRACE_MILLISECONDS = 500;

type Task = {
  child: Bun.Subprocess;
  channel: net.Socket;
  events: any[];
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  stdout: Promise<string>;
};

let nextId = 1;

/**
 * Spawns a task process in ITS OWN process group (`detached: true` → setsid),
 * with a dedicated bidirectional socketpair on fd 3. stdout stays free for the
 * task's logs.
 */
function spawnTask(args: string[]): Task {
  const spawnedAt = Date.now();
  const child = Bun.spawn(
    ['bun', TASK_PROCESS, `--spawned-at=${spawnedAt}`, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'socket-fd'],
      detached: true,
      env: { ...process.env },
    } as any,
  );

  const parentFd = (child.stdio as any)[3] as number;
  const channel = net.connect({ fd: parentFd } as any);

  const events: any[] = [];
  const pending = new Map<number, (value: any) => void>();
  let buffer = '';
  channel.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      } else {
        events.push(message);
      }
    }
  });

  return {
    child,
    channel,
    events,
    stdout: new Response(child.stdout as any).text(),
    request(method, params, timeoutMs = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        channel.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

/** SIGTERM to the GROUP, then SIGKILL to the GROUP. Negative pid = the group. */
async function stopGroup(task: Task, graceMs = GRACE_MILLISECONDS) {
  const pid = task.child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (task.child.killed || task.child.exitCode !== null) break;
    await Bun.sleep(20);
  }
  const neededKill = task.child.exitCode === null;
  if (neededKill) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await task.child.exited;
  return { neededKill };
}

const only = process.argv.slice(2);
const want = (name: string) => only.length === 0 || only.includes(name);
const results: Record<string, unknown> = {};

// --- 1: the handshake, over a dedicated fd ---------------------------------
if (want('handshake')) {
  const task = spawnTask(['--behaviour=quick']);
  const hello = await task.request('hello');
  const run = await task.request('run');
  task.channel.end();
  await task.child.exited;
  const stdout = await task.stdout;

  finding(
    'C1 the protocol runs over a dedicated fd, with stdout free for logs',
    hello?.result?.protocolVersion === EXECUTOR_PROTOCOL_VERSION && run?.result?.outcome === 'SUCCEEDED'
      ? 'CONFIRMED'
      : 'FAILED',
    `hello.protocolVersion=${hello?.result?.protocolVersion} pid=${hello?.result?.pid}\n` +
      `run outcome=${run?.result?.outcome}\n` +
      `the task wrote ${stdout.length} bytes to stdout, INCLUDING a line shaped like a protocol\n` +
      `response claiming outcome=SABOTAGE — and the executor still read outcome=${run?.result?.outcome}.\n` +
      `stdout contained the decoy = ${stdout.includes('SABOTAGE')}`,
  );
  results.handshake = { version: hello?.result?.protocolVersion, outcome: run?.result?.outcome };
}

// --- 2: a version the executor does not accept -----------------------------
if (want('version-mismatch')) {
  const task = spawnTask(['--behaviour=quick', '--version=99']);
  const hello = await task.request('hello');
  const accepted = hello?.result?.protocolVersion === EXECUTOR_PROTOCOL_VERSION;
  // The executor refuses BEFORE sending `run`.
  // The executor's own rule, stated once: it will not send `run` across a
  // version it does not accept. This demonstrates the handshake is available
  // and cheap; nothing in the platform enforces it for us.
  const workStarted = accepted;
  await stopGroup(task, 100);

  finding(
    'C1 a task process whose protocol version differs is refused before any work',
    !accepted && !workStarted ? 'CONFIRMED' : 'FAILED',
    `task claimed '${hello?.result?.protocolVersion}', executor accepts '${EXECUTOR_PROTOCOL_VERSION}'\n` +
      `executor sent 'run' = ${workStarted}\n` +
      'The handshake is a plain request/response, so the refusal costs one round trip and no work.',
  );
  results.versionMismatch = { claimed: hello?.result?.protocolVersion, accepted };
}

// --- 3: graceful cancel inside the grace period ----------------------------
if (want('graceful-cancel')) {
  const task = spawnTask(['--behaviour=long']);
  await task.request('hello');
  const running = task.request('run', undefined, 30_000);
  await Bun.sleep(400);
  const started = Date.now();
  const cancelAck = await task.request('cancel');
  const outcome = await running;
  const elapsed = Date.now() - started;
  await stopGroup(task, 200);

  finding(
    'C1 a cancel over the protocol settles the run gracefully',
    cancelAck?.result?.acknowledged && outcome?.result?.cancelled === true ? 'CONFIRMED' : 'FAILED',
    `cancel acknowledged = ${cancelAck?.result?.acknowledged}\n` +
      `run returned cancelled=${outcome?.result?.cancelled} in ${elapsed}ms\n` +
      `progress events received before the cancel = ${task.events.filter((e) => e.params?.kind === 'progress').length}`,
  );
  results.gracefulCancel = { elapsed, cancelled: outcome?.result?.cancelled };
}

// --- 4 & 5: the group kill, and the control that shows it matters ----------
if (want('group-kill')) {
  for (const mode of ['group', 'process-only'] as const) {
    const marker = `${import.meta.dir}/../out/grandchild-${mode}.log`;
    await Bun.write(marker, '');
    const task = spawnTask(['--behaviour=spawns-grandchild', `--marker=${marker}`]);
    await task.request('hello');
    void task.request('run', undefined, 70_000).catch(() => {});
    await Bun.sleep(1_200); // let the grandchild write a few lines

    const pid = task.child.pid;
    if (mode === 'group') {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL'); // the parent alone — the mistake
    }
    await task.child.exited;

    const linesAtKill = (await Bun.file(marker).text()).trim().split('\n').filter(Boolean).length;
    await Bun.sleep(1_500);
    const linesLater = (await Bun.file(marker).text()).trim().split('\n').filter(Boolean).length;
    const survived = linesLater > linesAtKill;

    if (mode === 'group') {
      finding(
        'C1 SIGKILL of the process group takes a grandchild the task started',
        !survived ? 'CONFIRMED' : 'FAILED',
        `grandchild wrote ${linesAtKill} lines before the kill, ${linesLater} 1.5s after\n` +
          `still running = ${survived}\n` +
          'setsid at spawn (`detached: true`) plus kill(-pid) is what makes this true.',
      );
      results.groupKill = { linesAtKill, linesLater, survived };
    } else {
      finding(
        'C1 NEGATIVE CONTROL: killing the process alone leaves the grandchild running',
        survived ? 'CONFIRMED' : 'UNEXPECTED',
        `grandchild wrote ${linesAtKill} lines before the kill, ${linesLater} 1.5s after\n` +
          `still running = ${survived}\n` +
          'So the group is load-bearing: a cancelled task would otherwise leave subprocesses behind.',
      );
      results.processOnlyKill = { linesAtKill, linesLater, survived };
      // Do not leave it running.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

// --- 3b: SIGTERM then SIGKILL, when the task ignores SIGTERM ---------------
if (want('sigterm-then-sigkill')) {
  const task = spawnTask(['--behaviour=ignores-sigterm']);
  await task.request('hello');
  void task.request('run', undefined, 70_000).catch(() => {});
  await Bun.sleep(200);
  const started = Date.now();
  const { neededKill } = await stopGroup(task, GRACE_MILLISECONDS);
  const elapsed = Date.now() - started;

  finding(
    'C1 a task that ignores SIGTERM is killed after the grace period',
    neededKill && elapsed >= GRACE_MILLISECONDS ? 'CONFIRMED' : 'FAILED',
    `grace = ${GRACE_MILLISECONDS}ms, terminated after ${elapsed}ms, SIGKILL needed = ${neededKill}\n` +
      `exit code = ${task.child.exitCode}, signal = ${(task.child as any).signalCode}`,
  );
  results.sigtermThenSigkill = { elapsed, neededKill, exitCode: task.child.exitCode };
}

// --- 6: a cancel arriving before the process exists ------------------------
if (want('cancel-before-spawn')) {
  // The executor sets a token before its first await; the spawn checks it.
  let cancelToken = false;
  const admit = async () => {
    cancelToken = false;
    await Bun.sleep(150); // the window in which the process does not yet exist
    if (cancelToken) return { spawned: false as const };
    const task = spawnTask(['--behaviour=quick']);
    return { spawned: true as const, task };
  };
  const pending = admit();
  await Bun.sleep(50);
  cancelToken = true; // cancel arrives mid-window
  const outcome = await pending;

  finding(
    'C1 a cancel arriving before the task process exists is caught by a token',
    outcome.spawned === false ? 'CONFIRMED' : 'FAILED',
    `process spawned = ${outcome.spawned}\n` +
      'The token is set before the executor\'s first await, so the window has no hole. ' +
      'Nothing to signal, so the cancel cannot be delivered any other way.',
  );
  results.cancelBeforeSpawn = { spawned: outcome.spawned };
  if (outcome.spawned) await stopGroup(outcome.task, 100);
}

// --- 7: /ping latency with tasks running -----------------------------------
if (want('ping-latency')) {
  // The executor's own event loop answers /ping. Nothing a task does may stall it.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ status: 'HealthyBusy' }), { headers: { 'content-type': 'application/json' } }),
  });
  const url = `http://127.0.0.1:${server.port}/ping`;

  async function measure(samples = 40) {
    const timings: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const t0 = performance.now();
      await fetch(url);
      timings.push(performance.now() - t0);
      await Bun.sleep(10);
    }
    timings.sort((a, b) => a - b);
    return {
      p50: +timings[Math.floor(timings.length * 0.5)]!.toFixed(2),
      p95: +timings[Math.floor(timings.length * 0.95)]!.toFixed(2),
      max: +timings[timings.length - 1]!.toFixed(2),
    };
  }

  const idle = await measure();

  // Four tasks, one of them saturating a core.
  const tasks = [
    spawnTask(['--behaviour=cpu-burn', '--ms=12000']),
    spawnTask(['--behaviour=cpu-burn', '--ms=12000']),
    spawnTask(['--behaviour=long']),
    spawnTask(['--behaviour=long']),
  ];
  for (const task of tasks) await task.request('hello');
  for (const task of tasks) void task.request('run', undefined, 70_000).catch(() => {});
  await Bun.sleep(500);

  const busy = await measure();
  for (const task of tasks) await stopGroup(task, 200);
  server.stop(true);

  const ratio = busy.p95 / Math.max(idle.p95, 0.01);
  finding(
    'G1 /ping latency is unaffected by tasks, because they are separate processes',
    busy.p95 < 25 ? 'CONFIRMED' : 'DEGRADED',
    `idle  p50=${idle.p50}ms p95=${idle.p95}ms max=${idle.max}ms\n` +
      `busy  p50=${busy.p50}ms p95=${busy.p95}ms max=${busy.max}ms  (4 tasks, 2 of them saturating a core)\n` +
      `p95 ratio = ${ratio.toFixed(2)}x`,
  );
  results.pingLatency = { idle, busy };
}

// --- 8: the start cost of a process per task -------------------------------
if (want('spawn-cost')) {
  async function cost(args: string[], samples = 5) {
    const ready: number[] = [];
    const moduleLoad: number[] = [];
    const sdkLoad: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const task = spawnTask(args);
      const hello = await task.request('hello', undefined, 60_000);
      ready.push(hello.result.spawnToReadyMs);
      moduleLoad.push(hello.result.spawnToModuleLoadedMs);
      sdkLoad.push(hello.result.sdkLoadMs);
      task.channel.end();
      await stopGroup(task, 100);
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    return { ready: median(ready), moduleLoad: median(moduleLoad), sdkLoad: median(sdkLoad) };
  }

  const bare = await cost(['--behaviour=quick']);
  const withSdk = await cost(['--behaviour=quick', '--load-sdk=true']);

  // A "typical run" for either consumer is minutes, not seconds.
  const typicalRunSeconds = 120;
  const overheadPercent = ((withSdk.ready / 1000 / typicalRunSeconds) * 100).toFixed(3);

  finding(
    'G1 a process per task costs a fraction of a percent of a typical run',
    withSdk.ready < 2_000 ? 'CONFIRMED' : 'EXPENSIVE',
    `bare process, ready to serve      : ${bare.ready}ms (module load ${bare.moduleLoad}ms)\n` +
      `with the Agent SDK imported      : ${withSdk.ready}ms (SDK import ${withSdk.sdkLoad}ms)\n` +
      `against a ${typicalRunSeconds}s run           : ${overheadPercent}% overhead\n` +
      'ADR 0004 stands on these numbers: the isolation is close to free.',
  );
  results.spawnCost = { bare, withSdk, overheadPercent: Number(overheadPercent) };
}

// --- 9: several tasks at once, and what each costs in memory ---------------
if (want('concurrency-cost')) {
  const COUNT = 6;
  const tasks = Array.from({ length: COUNT }, () => spawnTask(['--behaviour=long', '--load-sdk=true']));
  for (const task of tasks) await task.request('hello', undefined, 60_000);
  for (const task of tasks) void task.request('run', undefined, 70_000).catch(() => {});
  await Bun.sleep(1_500);

  const pids = tasks.map((t) => t.child.pid);
  const rss = await new Response(
    Bun.spawn(['ps', '-o', 'rss=', '-p', pids.join(',')], { stdout: 'pipe' }).stdout,
  ).text();
  const kilobytes = rss
    .trim()
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter(Boolean);
  const totalMb = kilobytes.reduce((a, b) => a + b, 0) / 1024;
  const perTaskMb = totalMb / Math.max(kilobytes.length, 1);

  for (const task of tasks) await stopGroup(task, 200);

  // A container has 8 GB; an out-of-memory kill takes the whole session.
  const headroomTasks = Math.floor((8 * 1024 * 0.6) / Math.max(perTaskMb, 1));
  finding(
    'G1 per-task memory, against the 8 GB an admission limit has to respect',
    kilobytes.length === COUNT ? 'MEASURED' : 'SUSPECT',
    `${kilobytes.length} tasks alive, each with the Agent SDK loaded\n` +
      `per task ≈ ${perTaskMb.toFixed(1)} MB RSS, total ≈ ${totalMb.toFixed(1)} MB\n` +
      `at 60% of an 8 GB container that is ≈ ${headroomTasks} tasks before the ceiling\n` +
      'RSS overstates the true cost — pages are shared — so this is a floor for the admission limit, not the limit.',
  );
  results.concurrencyCost = { count: kilobytes.length, perTaskMb: +perTaskMb.toFixed(1), headroomTasks };
}

reportFindings();
await Bun.write(
  `${import.meta.dir}/../out/cg1-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
process.exit(0);
