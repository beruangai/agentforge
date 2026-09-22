/**
 * §C — is the grace period USABLE?
 *
 * Knowing a stopped container has about 60 seconds is only half an answer. The
 * design question is whether it can still reach the network in them and record
 * an outcome — because if it cannot, "a side effect's recovery is the
 * consumer's" has nowhere to run and `LOST` is the only honest state.
 *
 * The container writes an outcome row to DynamoDB from inside its SIGTERM
 * handler. This starts a task, stops the session, and reads the row.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/c3-outcome-in-grace.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ??
  'arn:aws:bedrock-agentcore:us-west-2:913756569129:runtime/agentforge_spike_a2a-mEyoz249T3';
const TABLE = 'agentforge-spike-lease';
const agentcore = new BedrockAgentCoreClient({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });

const sessionId = `grace-outcome-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
const leaseId = `spike-${randomUUID()}`;

async function send(data: any) {
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { kind: 'message', messageId: randomUUID(), role: 'user', contextId: randomUUID(), parts: [{ kind: 'data', data }] }, configuration: { blocking: false } },
  });
  const response = await agentcore.send(new InvokeAgentRuntimeCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionId, contentType: 'application/json', accept: 'application/json', payload: Buffer.from(payload) }));
  return JSON.parse(await response.response!.transformToString()).result;
}

console.log('\n§C — can a stopped container still record an outcome?\n');
await send({ runMilliseconds: 100 });
const task = await send({ runMilliseconds: 120_000, lease: { tableName: TABLE, leaseId, renewMilliseconds: 5_000, renewals: 40 } });
console.log(`  120s task running on container ${String(task?.metadata?.containerId).slice(0, 8)}`);

await new Promise((r) => setTimeout(r, 3_000));
const stopAt = Date.now();
await agentcore.send(new StopRuntimeSessionCommand({ agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionId }));
console.log(`  session stopped; the container should be mid-task\n`);

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1_000));
  const row = await dynamo.send(new GetItemCommand({ TableName: TABLE, Key: { leaseId: { S: `${leaseId}#outcome` } } }));
  if (row.Item) {
    console.log(`  outcome row found ${Date.now() - stopAt}ms after the stop`);
    console.log(`    outcome                : ${row.Item.outcome?.S}`);
    console.log(`    container              : ${row.Item.containerId?.S?.slice(0, 8)}`);
    console.log(`    written after SIGTERM  : ${row.Item.recordedAfterSigtermMs?.N}ms`);
    console.log(`    live tasks at SIGTERM  : ${row.Item.liveTasksAtSigterm?.N}`);
    console.log('\n  The grace period is USABLE: a stopped container reached the network');
    console.log('  and recorded an outcome while a task was still running.\n');
    await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { leaseId: { S: `${leaseId}#outcome` } } }));
    await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { leaseId: { S: leaseId } } }));
    process.exit(0);
  }
}
console.log('  NO outcome row after 12s. The container could not record one — check CloudWatch');
console.log('  for a shutdown-outcome event with ok:false.\n');
