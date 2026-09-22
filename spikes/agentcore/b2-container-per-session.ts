/**
 * §B — is a container started per runtime session, or drawn from a pool?
 *
 * On 2026-09-22 eleven `listening` events were observed in CloudWatch shortly
 * after `CreateAgentRuntime`, before any invocation, and read as a pre-warmed
 * pool. That reading was never tested. This tests it: fire N brand-new
 * sessions, then fire the same N again, and compare container ids and first-
 * call latency. A pool and a per-session start are distinguishable — a pool
 * shows no cold-start penalty on a session's first call.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/b2-container-per-session.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
const SESSIONS = 6;

async function send(sessionId: string) {
  const startedAt = Date.now();
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId: randomUUID(),
        parts: [{ kind: 'data', data: { runMilliseconds: 200 } }],
      },
      configuration: { blocking: false },
    },
  });
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(payload),
    }),
  );
  const body = JSON.parse(await response.response!.transformToString());
  return {
    latencyMs: Date.now() - startedAt,
    containerId: body.result?.metadata?.containerId as string,
    containerUptimeMs: body.result?.metadata?.containerUptimeMs as number,
  };
}

// Warm the client FIRST. Credential resolution, TLS and the SDK's own lazy
// module loading all land on whatever call happens to be first, and reading
// that as session-establishment cost would be wrong: on the first run of this
// spike six parallel first calls each showed ~2.66s while a later new session
// in another spike showed 677ms. The difference was the client, not the
// platform. So: warm up, discard, then measure.
const warmupSession = `warmup-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
const warmup = await send(warmupSession);
console.log(`\n  (client warm-up call, discarded: ${warmup.latencyMs}ms)`);

const ids = Array.from({ length: SESSIONS }, (_, i) => `pool-${Date.now()}-${i}-${randomUUID().replace(/-/g, '')}`);
const windowStart = Date.now();

console.log(`\n§B — ${SESSIONS} brand-new sessions, fired together\n`);
const firstRound = await Promise.all(ids.map(send));
firstRound.forEach((r, i) =>
  console.log(`  session ${i}  ${String(r.latencyMs).padStart(5)}ms  container=${r.containerId.slice(0, 8)}  container had been up ${r.containerUptimeMs}ms`),
);

await new Promise((r) => setTimeout(r, 3_000));
console.log(`\nthe same ${SESSIONS} sessions again, 3s later\n`);
const secondRound = await Promise.all(ids.map(send));
secondRound.forEach((r, i) =>
  console.log(`  session ${i}  ${String(r.latencyMs).padStart(5)}ms  container=${r.containerId.slice(0, 8)}  up ${r.containerUptimeMs}ms`),
);

const firstIds = new Set(firstRound.map((r) => r.containerId));
const stable = firstRound.filter((r, i) => r.containerId === secondRound[i]!.containerId).length;
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log('\n── what this shows ──');
console.log(`  distinct containers, round 1 : ${firstIds.size} for ${SESSIONS} sessions`);
console.log(`  sessions pinned to the same container across rounds : ${stable}/${SESSIONS}`);
console.log(`  median first-call latency  : ${median(firstRound.map((r) => r.latencyMs))}ms`);
console.log(`  median second-call latency : ${median(secondRound.map((r) => r.latencyMs))}ms`);
console.log(`  session establishment cost : ${median(firstRound.map((r) => r.latencyMs)) - median(secondRound.map((r) => r.latencyMs))}ms (first minus steady-state, client already warm)`);
console.log(`  container uptime at a session's FIRST call : ${firstRound.map((r) => r.containerUptimeMs).join(', ')}ms`);
console.log(
  `\n  A container whose uptime is already seconds at a session's first call was\n` +
    `  running before that session existed — a pool. An uptime of a few hundred ms\n` +
    `  means it was started for the session.`,
);
console.log(`\n  window for the log check: ${new Date(windowStart).toISOString()} onwards\n`);
