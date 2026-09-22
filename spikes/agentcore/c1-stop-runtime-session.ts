/**
 * §C, platform half — what `StopRuntimeSession` actually does to a container
 * that is mid-task, and what the container is given to finish in.
 *
 * `ARCHITECTURE.md` treats cancellation as cooperative: the task process is
 * asked to stop and is given a grace period. Whether the platform offers the
 * same courtesy — a SIGTERM, then time — is the question, because if it does
 * not, a cancelled run loses its side-effect recovery.
 *
 * The container logs `sigterm` with its own container id and a timestamp, and
 * keeps running deliberately, so the grace period is measurable as the gap
 * between SIGTERM and the moment the container stops answering.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/c1-stop-runtime-session.ts
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  GetAgentCardCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

async function rpc(sessionId: string, method: string, params: any) {
  const startedAt = Date.now();
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
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
    return { ok: true as const, latencyMs: Date.now() - startedAt, body };
  } catch (error: any) {
    return {
      ok: false as const,
      latencyMs: Date.now() - startedAt,
      status: error.$metadata?.httpStatusCode,
      detail: error.error ? `${error.error.code} ${error.error.message}` : `${error.name}: ${error.message}`,
    };
  }
}

const send = (sessionId: string, runMilliseconds: number) =>
  rpc(sessionId, 'message/send', {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      contextId: randomUUID(),
      parts: [{ kind: 'data', data: { runMilliseconds } }],
    },
    configuration: { blocking: false },
  });

const container = (r: any) => r.body?.result?.metadata?.containerId?.slice(0, 8) ?? '—';

console.log('\n§C — StopRuntimeSession against a container that is mid-task\n');

// Warm the client so the first measured call is not carrying SDK start-up.
await send(`warm-${Date.now()}-${randomUUID().replace(/-/g, '')}`, 100);

const sessionId = `stop-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
const started = await send(sessionId, 60_000);
const taskId = (started as any).body?.result?.id;
const victim = container(started);
console.log(`  60s task started      container=${victim} task=${String(taskId).slice(0, 8)}`);

await new Promise((r) => setTimeout(r, 2_000));
const beforeStop = await rpc(sessionId, 'tasks/get', { id: taskId });
console.log(`  before stop           container=${container(beforeStop)} state=${(beforeStop as any).body?.result?.status?.state}`);

const stopAt = Date.now();
try {
  const stopped = await client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionId }));
  console.log(`\n  StopRuntimeSession OK  (${Date.now() - stopAt}ms)  ${JSON.stringify({ status: stopped.statusCode ?? null, id: stopped.runtimeSessionId?.slice(0, 12) })}`);
} catch (error: any) {
  console.log(`\n  StopRuntimeSession FAILED  HTTP ${error.$metadata?.httpStatusCode} ${error.name}: ${error.message}`);
}

console.log('\n  polling the same session after the stop\n');
for (let i = 0; i < 14; i++) {
  const probe = await rpc(sessionId, 'tasks/get', { id: taskId });
  const elapsed = String(Date.now() - stopAt).padStart(6);
  if (probe.ok) {
    const c = container(probe);
    console.log(
      `  +${elapsed}ms  container=${c}${c !== victim && c !== '—' ? '  ← A DIFFERENT CONTAINER' : ''}  ` +
        `state=${(probe as any).body?.result?.status?.state ?? (probe as any).body?.error?.message ?? '—'}`,
    );
  } else {
    console.log(`  +${elapsed}ms  HTTP ${probe.status}  ${probe.detail}`);
  }
  await new Promise((r) => setTimeout(r, 1_500));
}

// §I — does AgentCore serve the card, and does it serve OUR card?
console.log('\n§I — GetAgentCard through the control plane\n');
try {
  const card = await client.send(new GetAgentCardCommand({ agentRuntimeArn: RUNTIME_ARN }));
  const served: any = card.agentCard ?? card;
  const text = JSON.stringify(served);
  console.log(`  served card, ${text.length} bytes`);
  console.log(`  name              ${served.name ?? '—'}`);
  console.log(`  protocolVersion   ${served.protocolVersion ?? '—'}`);
  console.log(`  url               ${served.url ?? '—'}`);
  console.log(`  supportedInterfaces ${JSON.stringify(served.supportedInterfaces ?? served.additionalInterfaces ?? null)}`);
  console.log(`  is it ours?       ${served.name === 'agentforge-spike' ? 'YES — served verbatim from the container' : 'NO — synthesised by the platform'}`);
} catch (error: any) {
  console.log(`  GetAgentCard FAILED  HTTP ${error.$metadata?.httpStatusCode} ${error.name}: ${error.message}`);
}

console.log(`\n  container under test: ${victim}. Correlate the sigterm event in CloudWatch.\n`);
