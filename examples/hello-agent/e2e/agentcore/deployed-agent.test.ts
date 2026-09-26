/**
 * The whole path, on AgentCore: a caller, through AgentForge's client and
 * `agentCoreTransport`, to this agent as `deploy` left it — the runtime, the
 * harness, the Agent SDK and a real model — and back as a typed outcome; and
 * a task whose container the platform stops ends `LOST`, its retry running as
 * the next attempt.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  agentCoreTransport,
  awaitTask,
  createClient,
} from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { helloAgent } from '../../files/contract.ts';

/** Where `deploy` writes its stack outputs. */
const DEPLOY_OUTPUTS = new URL(
  '../../../../dist/examples/hello-agent/deploy/outputs.json',
  import.meta.url,
);

function deployedAgentRuntimeArn(): string {
  const outputs = JSON.parse(readFileSync(DEPLOY_OUTPUTS, 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  const arn = outputs['agentforge-example-hello-agent']?.AgentRuntimeArn;
  if (arn === undefined) {
    throw new Error(`no AgentRuntimeArn in ${DEPLOY_OUTPUTS.pathname}`);
  }
  return arn;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set; run through \`nx run @beruangai/example-hello-agent:e2e-agentcore\`, which loads it from .env.integ`,
    );
  }
  return value;
}

/** AgentCore requires at least 33 characters. */
const newRuntimeSessionId = (): string => `e2e-${randomUUIDv7()}`;

let agentRuntimeArn: string;
let region: string;
let client: ReturnType<typeof createClient<typeof helloAgent>>;

beforeAll(() => {
  region = required('AWS_REGION');
  agentRuntimeArn = deployedAgentRuntimeArn();
  client = createClient(
    helloAgent,
    agentCoreTransport({ agentRuntimeArn, region }),
  );
});

describe('hello-agent, on AgentCore', () => {
  it('runs a procedure to its validated, typed output, and attaches a retry to it', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await client.summarise.SendMessage(
      {
        text: 'AgentForge runs a Claude agent procedure as an asynchronous task and returns a typed outcome.',
      },
      context,
    );
    const ended = await awaitTask(client.summarise, started, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    expect(ended.runs[0]?.totalCostUsd).toBeGreaterThan(0);

    const retry = await client.summarise.SendMessage(
      { text: 'ignored: the key names the completed task' },
      context,
    );
    expect(retry).toMatchObject({
      taskId: started.taskId,
      state: 'TASK_STATE_COMPLETED',
      output: ended.output,
    });
  });

  it('ends a task LOST when the platform stops its container mid-Bash, and runs the retry as the next attempt', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await client.sleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await delay(20_000);
    const running = await client.sleepThenAnswer.GetTask(
      started.taskId,
      context,
    );
    expect(running.state).toBe('TASK_STATE_WORKING');
    await new BedrockAgentCoreClient({ region }).send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn,
        runtimeSessionId: context.runtimeSessionId,
      }),
    );
    // The next call lands on a fresh container, which reads the task from the store.
    const ended = await awaitTask(client.sleepThenAnswer, started, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'LOST', retryable: true },
    });

    const retry = await client.sleepThenAnswer.SendMessage(
      { seconds: 1 },
      context,
    );
    expect(retry.taskId).not.toBe(started.taskId);
    const retried = await awaitTask(client.sleepThenAnswer, retry, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    if (retried.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(retried)}`);
    }
    expect(retried.attempt).toBe(2);
    expect(retried.output.answer.length).toBeGreaterThan(0);
  });
});
