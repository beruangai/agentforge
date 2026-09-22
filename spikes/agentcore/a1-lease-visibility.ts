/**
 * §A — the lease, written and renewed from inside a microVM and read from
 * outside. Measures what §A asks for: visibility latency, renewal cost at a
 * chosen interval, and what a poll costs to read.
 *
 * Clocks, and why the measurement moved. A first version polled DynamoDB from
 * a laptop and reported ~322ms "visibility". That figure conflated four things:
 * the write, DynamoDB's propagation, a 239ms read RTT from outside AWS, and a
 * 333ms apparent offset between two unsynchronised clocks — an offset of the
 * same order as the invoke RTT, so probably mostly asymmetric latency rather
 * than skew. None of it was a platform number, and it is not recorded as one.
 *
 * So the container now writes AND reads back, on ONE clock over ONE network,
 * and reports write latency and write-to-visible per renewal. What an external
 * reader adds on top is its own RTT, which depends on where the caller runs —
 * measured here only to show it dominates.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/a1-lease-visibility.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const TABLE = 'agentforge-spike-lease';
const RENEW_MILLISECONDS = 2_000;
const RENEWALS = 6;

const agentcore = new BedrockAgentCoreClient({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });

async function send(sessionId: string, data: any) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { kind: 'message', messageId: randomUUID(), role: 'user', contextId: randomUUID(), parts: [{ kind: 'data', data }] },
      configuration: { blocking: false },
    },
  });
  const t0 = Date.now();
  const response = await agentcore.send(
    new InvokeAgentRuntimeCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionId, contentType: 'application/json', accept: 'application/json', payload: Buffer.from(payload) }),
  );
  const body = JSON.parse(await response.response!.transformToString());
  const t2 = Date.now();
  return { t0, t2, metadata: body.result?.metadata ?? {}, taskId: body.result?.id as string };
}

const session = `lease-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
console.log('\n§A — a lease written and renewed from inside a microVM\n');

await send(session, { runMilliseconds: 100 }); // warm the client and the session

const leaseId = `spike-${randomUUID()}`;
const runMilliseconds = RENEW_MILLISECONDS * RENEWALS + 4_000;
console.log(`  ${RENEWALS} renewals every ${RENEW_MILLISECONDS}ms, lease ${leaseId.slice(0, 14)}…\n`);
const started = await send(session, {
  runMilliseconds,
  lease: { tableName: TABLE, leaseId, renewMilliseconds: RENEW_MILLISECONDS, renewals: RENEWALS },
});

// What a reader OUTSIDE AWS pays, for comparison only.
const externalReads: number[] = [];
const until = Date.now() + runMilliseconds + 1_000;
while (Date.now() < until) {
  const before = Date.now();
  await dynamo.send(new GetItemCommand({ TableName: TABLE, Key: { leaseId: { S: leaseId } } }));
  externalReads.push(Date.now() - before);
  await new Promise((r) => setTimeout(r, 1_000));
}

// The container reports its own figures on the terminal status update.
const final = await agentcore.send(
  new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: session,
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: started.taskId } })),
  }),
);
const task = JSON.parse(await final.response!.transformToString()).result;
const measured: { writeLatencyMs: number; visibleAfterMs: number | null; readBackPolls: number }[] =
  task?.status?.message?.metadata?.leaseLatencies ?? task?.metadata?.leaseLatencies ?? [];

const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN);

if (measured.length === 0) {
  console.log('  the terminal update carried no lease figures; reading them from CloudWatch instead:');
  console.log(`    bash agentcore/read-lease.sh ${started.metadata.containerId}\n`);
} else {
  console.log('  gen   write   write→visible   polls');
  measured.forEach((m, i) =>
    console.log(`   ${String(i + 1).padStart(2)}   ${String(m.writeLatencyMs).padStart(4)}ms   ${String(m.visibleAfterMs ?? '—').padStart(10)}ms   ${m.readBackPolls}`),
  );
  console.log('\n── what this shows, all inside the microVM ──');
  console.log(`  median write latency         : ${median(measured.map((m) => m.writeLatencyMs))}ms`);
  console.log(`  median write → visible       : ${median(measured.map((m) => m.visibleAfterMs ?? 0))}ms`);
  console.log(`  read-backs needed            : ${measured.map((m) => m.readBackPolls).join(', ')}`);
}
console.log(`\n  for contrast, a read from OUTSIDE AWS (this laptop) : median ${median(externalReads)}ms over ${externalReads.length} reads`);
console.log(`  renewals over a 1-hour run at ${RENEW_MILLISECONDS}ms : ${Math.round(3_600_000 / RENEW_MILLISECONDS)} writes\n`);

await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { leaseId: { S: leaseId } } }));
console.log('  lease item deleted\n');
