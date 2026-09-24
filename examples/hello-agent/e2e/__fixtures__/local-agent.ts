import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';

const dynamoDBLocalImage =
  'amazon/dynamodb-local:3.1.0@sha256:7ef4a2c45b58c2901e70a4f28e0953a422c2c631baaaf5e2c15e0805740c7752';
const agentImage = 'agentforge-examples/hello-agent:local';

export interface LocalAgent {
  readonly url: string;
  logs(): string;
  stop(): void;
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A container's stdout and stderr together, as `docker logs` splits them. */
function logsOf(container: string): string {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}

function publishedAddress(container: string, port: number): string {
  const address = docker('port', container, `${port}/tcp`).split('\n')[0];
  if (!address) throw new Error(`${container} publishes no port ${port}`);
  return address;
}

async function until(
  description: string,
  deadlineMilliseconds: number,
  check: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + deadlineMilliseconds;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The agent's image running as it would locally: DynamoDB Local beside it on
 * a private network, the subscription token passed by name from this
 * process's environment, never written into a command line.
 */
export async function startLocalAgent(): Promise<LocalAgent> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set; the e2e target loads it from .env.integ.local',
    );
  }
  const suffix = randomUUIDv7().slice(-8);
  const network = `agentforge-e2e-${suffix}`;
  const dynamoDB = `agentforge-e2e-dynamodb-${suffix}`;
  const agent = `agentforge-e2e-agent-${suffix}`;
  const stop = () => {
    for (const container of [agent, dynamoDB]) {
      spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    }
    spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  };
  try {
    docker('network', 'create', network);
    docker(
      'run',
      '-d',
      '--name',
      dynamoDB,
      '--network',
      network,
      '-p',
      '127.0.0.1::8000',
      dynamoDBLocalImage,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
      '-sharedDb',
    );
    // The server creates its table as it starts, so DynamoDB Local must be
    // listening first. Any HTTP answer, even a 400, means it is.
    const dynamoDBUrl = `http://${publishedAddress(dynamoDB, 8000)}/`;
    await until('DynamoDB Local', 30_000, () =>
      fetch(dynamoDBUrl).then(
        () => true,
        () => false,
      ),
    );
    docker(
      'run',
      '-d',
      '--name',
      agent,
      '--network',
      network,
      '-p',
      '127.0.0.1::9000',
      '-e',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '-e',
      'AGENTFORGE_TABLE_NAME=agentforge-tasks',
      '-e',
      `AGENTFORGE_DYNAMODB_ENDPOINT=http://${dynamoDB}:8000`,
      '-e',
      'AWS_ACCESS_KEY_ID=local',
      '-e',
      'AWS_SECRET_ACCESS_KEY=local',
      '-e',
      'AWS_REGION=us-east-2',
      agentImage,
    );
    const url = `http://${publishedAddress(agent, 9000)}/`;
    await until('the agent to answer /ping', 60_000, () =>
      fetch(new URL('/ping', url)).then(
        (response) => response.ok,
        () => false,
      ),
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${logsOf(agent)}`);
    });
    return { url, logs: () => logsOf(agent), stop };
  } catch (error) {
    stop();
    throw error;
  }
}
