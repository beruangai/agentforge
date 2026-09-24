import { execFileSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { vi } from 'vitest';
import { createTaskTable } from '../../src/server/runtime/task-store.ts';

/** Pinned by digest: what the local store is tested against. */
export const dynamoDBLocalImage =
  'amazon/dynamodb-local:3.1.0@sha256:7ef4a2c45b58c2901e70a4f28e0953a422c2c631baaaf5e2c15e0805740c7752';

export interface DynamoDBLocal {
  readonly endpoint: string;
  readonly client: DynamoDBClient;
  /** A fresh table the task store expects. */
  createTable(): Promise<string>;
  stop(): void;
}

/** DynamoDB Local in Docker on a free port, with throwaway credentials. */
export async function startDynamoDBLocal(): Promise<DynamoDBLocal> {
  const name = `agentforge-integ-dynamodb-${randomUUIDv7().slice(-8)}`;
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      '127.0.0.1::8000',
      dynamoDBLocalImage,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
      '-sharedDb',
    ],
    { stdio: 'pipe' },
  );
  const port = execFileSync('docker', ['port', name, '8000/tcp'], {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new DynamoDBClient({
    endpoint,
    region: 'us-east-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await vi.waitUntil(
    () =>
      fetch(endpoint).then(
        () => true,
        () => false,
      ),
    { timeout: 30_000, interval: 250 },
  );
  return {
    endpoint,
    client,
    async createTable() {
      const tableName = `agentforge-tasks-${randomUUIDv7().slice(-8)}`;
      await createTaskTable(client, tableName);
      return tableName;
    },
    stop() {
      execFileSync('docker', ['stop', name], { stdio: 'pipe' });
    },
  };
}
