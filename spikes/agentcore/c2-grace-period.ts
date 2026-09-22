/**
 * §C — is the post-SIGTERM grace period a fixed window, or does AgentCore kill
 * the container as soon as it stops reporting HealthyBusy?
 *
 * The first run could not tell them apart: a 60s task was stopped and the
 * container died 56s after SIGTERM, which is both "about a minute" and "about
 * when the task finished". So: two sessions stopped at the same moment, one
 * holding a SHORT task and one a LONG one. A fixed window kills both at the
 * same offset; an idle-triggered kill follows each task.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/c2-grace-period.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

async function send(sessionId: string, runMilliseconds: number) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { kind: 'message', messageId: randomUUID(), role: 'user', contextId: randomUUID(), parts: [{ kind: 'data', data: { runMilliseconds } }] },
      configuration: { blocking: false },
    },
  });
  const response = await client.send(
    new InvokeAgentRuntimeCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionId, contentType: 'application/json', accept: 'application/json', payload: Buffer.from(payload) }),
  );
  const body = JSON.parse(await response.response!.transformToString());
  return body.result?.metadata?.containerId as string;
}

const cases = [
  { label: 'short task (4s)', runMilliseconds: 4_000 },
  { label: 'long task (240s)', runMilliseconds: 240_000 },
];

console.log('\n§C — fixed grace window, or killed once idle?\n');
const running = await Promise.all(
  cases.map(async (c) => {
    const sessionId = `grace-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
    const container = await send(sessionId, c.runMilliseconds);
    console.log(`  ${c.label.padEnd(18)} container=${container.slice(0, 8)}  session=${sessionId.slice(0, 18)}…`);
    return { ...c, sessionId, container };
  }),
);

await new Promise((r) => setTimeout(r, 2_000));
const stopAt = Date.now();
await Promise.all(running.map((r) => client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: r.sessionId }))));
console.log(`\n  both sessions stopped at ${new Date(stopAt).toISOString()}\n`);
console.log('  read the heartbeats with:');
console.log(`    bash agentcore/read-grace.sh ${running.map((r) => r.container.slice(0, 8)).join(' ')}\n`);
await Bun.write('/tmp/c2-containers.json', JSON.stringify({ stopAt, running }, null, 2));
