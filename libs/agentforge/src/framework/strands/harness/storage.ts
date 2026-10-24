import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage, type Storage } from '@strands-agents/sdk/storage';
import { AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import { s3ClientConfiguration } from '#core/s3-endpoint.ts';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';

/** Where an agent keeps its sessions, memory and offloaded tool results: the project's session bucket, under its name (ADR 0011). */
export interface AgentStorage {
  readonly bucket: string;
  readonly agent: string;
  readonly storage: Storage;
}

/**
 * The storage the deployment declares — the construct's bucket, or the local
 * store's that `serve` names — under the agent's name the executor gives it;
 * none where no bucket is named.
 */
export function storageFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AgentStorage | undefined {
  const bucket = environment[SESSION_BUCKET_VARIABLE];
  if (bucket === undefined || bucket === '') return undefined;
  const agent = environment[AGENT_NAME_VARIABLE];
  if (agent === undefined || agent === '') {
    throw new Error(
      `${SESSION_BUCKET_VARIABLE} names a session bucket, but ${AGENT_NAME_VARIABLE} is unset: an agent's storage is kept under its name`,
    );
  }
  return {
    bucket,
    agent,
    storage: new S3Storage(bucket, {
      prefix: `${agent}/`,
      s3Client: new S3Client(s3ClientConfiguration(environment)),
    }),
  };
}

/** A storage call the SDK makes. */
export type StorageOperation = 'write' | 'read' | 'list';

/**
 * The storage as the SDK sees it, reporting each call that failed. The SDK
 * swallows a failed write in a hook, keeps an unoffloaded result, and recalls
 * no memory from a failed read or list, so the runner fails the run instead
 * (ADR 0011). A missing key is not a failure: the storage reads it as `null`.
 */
export function recordingStorage(
  storage: Storage,
  onFailed: (operation: StorageOperation, key: string, error: unknown) => void,
): Storage {
  const reported = async <Result>(
    operation: StorageOperation,
    key: string,
    call: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      onFailed(operation, key, error);
      throw error;
    }
  };
  return {
    write: (key, data) =>
      reported('write', key, () => storage.write(key, data)),
    read: (key) => reported('read', key, () => storage.read(key)),
    delete: (key) => storage.delete(key),
    list: (prefix) => reported('list', prefix, () => storage.list(prefix)),
  };
}
