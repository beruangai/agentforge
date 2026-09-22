/**
 * §B — does a busy container still receive invocations, and what does one
 * AgentCore runtime session id actually map to?
 *
 * `ARCHITECTURE.md` §4 asserts that `/ping` is a lifecycle signal rather than
 * admission control, so a container should receive a start, a poll or a cancel
 * whatever it last reported. That is inference from the contract's silence, and
 * the whole await path rests on it. This asserts it against the real platform.
 *
 * The container mints a CONTAINER ID at process start and returns it on every
 * task, so "same container" is observed rather than assumed.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/b1-session-and-busy.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

/** AgentCore requires a session id of at least 33 characters. */
const session = (label: string) => `${label}-${Date.now()}-${randomUUID().replace(/-/g, '')}`.slice(0, 96);

type Call = {
  label: string;
  sessionId: string;
  startedAt: number;
  latencyMs: number;
  httpError?: string;
  body?: any;
};

const calls: Call[] = [];

async function rpc(label: string, sessionId: string, method: string, params: any): Promise<Call> {
  const startedAt = Date.now();
  const payload = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params });
  const call: Call = { label, sessionId, startedAt, latencyMs: 0 };
  try {
    const response = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        runtimeSessionId: sessionId,
        // CORRECTION to the 2026-09-22 finding: AgentCore does NOT strip
        // content-type — it forwards whatever the caller sent, and sends none
        // when the caller sent none (which is what the CLI does). This SDK
        // defaults to `application/octet-stream`, which the A2A SDK's
        // jsonRpcHandler rejects with -32005, surfacing as HTTP 424 / -32055
        // "Runtime client error". Setting it is the fix.
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(payload),
      }),
    );
    const text = await response.response!.transformToString();
    call.latencyMs = Date.now() - startedAt;
    try {
      call.body = JSON.parse(text);
    } catch {
      call.body = { raw: text.slice(0, 400) };
    }
  } catch (error: any) {
    call.latencyMs = Date.now() - startedAt;
    // A 424 carries the container's own JSON-RPC error on the exception.
    call.httpError = `HTTP ${error.$metadata?.httpStatusCode ?? '?'} ${error.error ? `${error.error.code} ${error.error.message}` : error.message}`;
    if (error.error) call.body = { jsonrpc: '2.0', error: error.error };
  }
  calls.push(call);
  return call;
}

/**
 * The 0.3 wire shape, deliberately. AgentCore forwards no `A2A-Version` header,
 * so the server negotiates 0.3 — and a 1.0-shaped part is stripped of its
 * content in transit without an error (§I finding, 2026-09-22).
 */
const send = (label: string, sessionId: string, runMilliseconds: number, idempotencyKey?: string) =>
  rpc(label, sessionId, 'message/send', {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      contextId: randomUUID(),
      parts: [{ kind: 'data', data: { runMilliseconds, idempotencyKey: idempotencyKey ?? null } }],
    },
    configuration: { blocking: false },
  });

const task = (call: Call) => call.body?.result ?? call.body?.result?.task ?? undefined;
const meta = (call: Call) => task(call)?.metadata ?? {};
const short = (id?: string) => (id ? id.slice(0, 8) : '—');

const line = (call: Call, extra = '') =>
  console.log(
    `  ${call.label.padEnd(34)} ${String(call.latencyMs).padStart(6)}ms  ` +
      `container=${short(meta(call).containerId)} live=${meta(call).liveTasks ?? '—'} ` +
      `${call.httpError ? `ERROR ${call.httpError}` : call.body?.error ? `rpc ${call.body.error.code} ${call.body.error.message}` : ''} ${extra}`,
  );

console.log('\n§B — a busy container, and what a runtime session id maps to\n');

// ── B1: a long task, then a second call to the SAME session while it runs ────
const s1 = session('busy');
console.log(`session A ${s1.slice(0, 20)}…`);
const long = await send('long task (25s), returns at once', s1, 25_000, 'idem-long');
line(long);
const longTaskId = task(long)?.id;

await new Promise((r) => setTimeout(r, 1_500));

// Fired together: if /ping's HealthyBusy were admission control, these stall.
const [second, got, cancelled] = await Promise.all([
  send('2nd send while busy', s1, 1_500),
  longTaskId ? rpc('tasks/get while busy', s1, 'tasks/get', { id: longTaskId }) : Promise.resolve(undefined as any),
  new Promise<Call>((resolve) =>
    setTimeout(() => resolve(rpc('tasks/cancel while busy', s1, 'tasks/cancel', { id: longTaskId })), 800),
  ),
]);
line(second);
if (got) line(got, got.body?.result ? `state=${got.body.result.status?.state}` : '');
line(cancelled, cancelled.body?.result ? `state=${cancelled.body.result.status?.state}` : '');

await new Promise((r) => setTimeout(r, 2_000));
const after = longTaskId ? await rpc('tasks/get after cancel', s1, 'tasks/get', { id: longTaskId }) : undefined;
if (after) line(after, after.body?.result ? `state=${after.body.result.status?.state}` : '');

// ── B2: a DIFFERENT session, to see whether it lands on another container ────
const s2 = session('other');
console.log(`\nsession B ${s2.slice(0, 20)}…`);
const otherSession = await send('send on a second session', s2, 500);
line(otherSession);

// ── B3: session A again, after its work finished ─────────────────────────────
await new Promise((r) => setTimeout(r, 2_000));
const reuse = await send('session A again, now idle', s1, 500);
line(reuse);

// ── B4: idempotency — the same key twice on one session ──────────────────────
const key = `idem-${randomUUID()}`;
const first = await send('idempotency, first call', s1, 500, key);
const repeat = await send('idempotency, same key again', s1, 500, key);
line(first, `task=${short(task(first)?.id)}`);
line(repeat, `task=${short(task(repeat)?.id)}`);

console.log('\n── what this shows ──');
const containers = new Map<string, string[]>();
for (const call of calls) {
  const id = meta(call).containerId;
  if (!id) continue;
  if (!containers.has(id)) containers.set(id, []);
  containers.get(id)!.push(`${call.label} [${call.sessionId.slice(0, 5)}]`);
}
for (const [id, labels] of containers) console.log(`  container ${short(id)}  ←  ${labels.length} call(s): ${labels.join(', ')}`);

console.log(`\n  distinct containers seen : ${containers.size}`);
console.log(`  session A container(s)   : ${[...new Set(calls.filter((c) => c.sessionId === s1).map((c) => short(meta(c).containerId)))].join(', ')}`);
console.log(`  session B container(s)   : ${[...new Set(calls.filter((c) => c.sessionId === s2).map((c) => short(meta(c).containerId)))].join(', ')}`);
console.log(`  max concurrent liveTasks : ${Math.max(0, ...calls.map((c) => Number(meta(c).liveTasks ?? 0)))}`);
console.log(`  delivered while busy     : ${[second, got, cancelled].filter((c) => c && !c.httpError).length}/3`);
console.log(`  idempotency held         : ${task(first)?.id && task(first)?.id === task(repeat)?.id ? 'YES — same task id' : 'NO — different task ids'}`);
console.log(`  negotiated version       : ${meta(long).negotiatedVersion ?? '—'}`);

await Bun.write('/tmp/b1-calls.json', JSON.stringify(calls, null, 2));
console.log('\n  full transcript: /tmp/b1-calls.json\n');
