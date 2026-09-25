// The readiness probe: the handler of a CloudFormation custom resource that
// `AgentRuntime` updates with every new version of its runtime. AgentCore
// refuses invocations while a runtime is CREATING, and can refuse the first
// one after READY, with an error a client cannot tell from a bad request
// (docs/research/agentcore-runtime-observed.md). So the probe asks for a task
// that does not exist until the agent answers "Task not found" — a reply only
// AgentForge's server gives — and the deploy completes only once the runtime
// serves. Plain JavaScript on the AWS SDK the Lambda runtime bundles, so the
// construct ships it as it is; it is its own custom resource handler, so no
// provider function outlives the stack.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

/** A2A's TaskNotFoundError. */
const TASK_NOT_FOUND = -32001;
const RETRY_INTERVAL_MILLISECONDS = 5_000;
/** Kept back from the Lambda's own timeout, to answer CloudFormation in. */
const RESPONSE_MARGIN_MILLISECONDS = 30_000;

const client = new BedrockAgentCoreClient();

export async function handler(event, context) {
  let status = 'SUCCESS';
  let reason = '';
  try {
    if (event.RequestType !== 'Delete') {
      await probe(
        event.ResourceProperties.AgentRuntimeArn,
        Date.now() +
          context.getRemainingTimeInMillis() -
          RESPONSE_MARGIN_MILLISECONDS,
      );
    }
  } catch (error) {
    status = 'FAILED';
    reason = `${String(error)}${error.cause ? ` (last: ${String(error.cause)})` : ''}`;
    console.error(error);
  }
  await respond(event, status, reason, context.logStreamName);
}

async function probe(agentRuntimeArn, deadline) {
  let lastFailure;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    try {
      const code = await getUnknownTask(agentRuntimeArn);
      if (code === TASK_NOT_FOUND) {
        console.log(`${agentRuntimeArn} served on attempt ${attempt}`);
        return;
      }
      lastFailure = new Error(
        `answered JSON-RPC error ${code}, not ${TASK_NOT_FOUND}`,
      );
    } catch (error) {
      lastFailure = error;
    }
    console.log(`attempt ${attempt}: ${String(lastFailure)}`);
    await delay(RETRY_INTERVAL_MILLISECONDS);
  }
  throw new Error(`${agentRuntimeArn} did not serve before the deadline`, {
    cause: lastFailure,
  });
}

/** `GetTask` for a fresh id, in a fresh session; returns the JSON-RPC error code. */
async function getUnknownTask(agentRuntimeArn) {
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn,
    runtimeSessionId: `readiness-probe-${randomUUID()}`,
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'GetTask',
        params: { id: randomUUID() },
      }),
    ),
  });
  // AgentForge speaks A2A 1.0 only; added before signing, so it is forwarded.
  command.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers['A2A-Version'] = '1.0';
      return next(args);
    },
    { step: 'build', name: 'a2aVersionHeader' },
  );
  const response = await client.send(command);
  const body = JSON.parse(await response.response.transformToString());
  return body.error?.code;
}

/** The custom resource's answer, to the presigned URL CloudFormation waits on. */
async function respond(event, status, reason, logStreamName) {
  const response = await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'content-type': '' },
    body: JSON.stringify({
      Status: status,
      Reason: `${reason} (log stream ${logStreamName})`.slice(0, 3_000),
      PhysicalResourceId: event.PhysicalResourceId ?? 'readiness-probe',
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
    }),
  });
  if (!response.ok) {
    throw new Error(`CloudFormation response refused: ${response.status}`);
  }
}
