import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Duration } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { temporalConnectConfig } from './connection.ts';

/** Inside ECS's 120 s stop timeout, which `TemporalWorker` sets. */
const DEFAULT_SHUTDOWN_GRACE_TIME: Duration = '110s';

type Activities = Readonly<
  Record<string, (...args: never[]) => Promise<unknown>>
>;

export interface RunWorkerOptions {
  readonly taskQueue: string;
  /** The `bundle-workflows` output, beside the worker bundle. */
  readonly workflowBundle: URL;
  /** The consumer's own activities. */
  readonly activities: Activities;
  /** Every connected project's `projectActivities`. */
  readonly agentActivities: Activities;
  /** The project's `REQUIRED_SECRETS`, each read from the environment. */
  readonly requiredSecrets: readonly string[];
  /** Default '110s', inside ECS's 120 s stop timeout. */
  readonly shutdownGraceTime?: Duration;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Checks the environment, connects to Temporal as the environment names it,
 * and runs one worker over the prebuilt workflows and both activity sets
 * until a shutdown signal (SIGINT, SIGTERM, SIGQUIT, SIGUSR2). On one it
 * stops polling and gives running activities the grace time before
 * cancelling them — which leaves an agent's task running for the next
 * attempt to attach to.
 *
 * Throws before connecting, naming each problem: an unset required secret,
 * an activity name in both sets, a missing workflow bundle, the connection's
 * own refusals.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const environment = options.environment ?? process.env;
  const problems: string[] = [];
  const unset = options.requiredSecrets.filter(
    (name) => (environment[name] ?? '') === '',
  );
  if (unset.length > 0) {
    problems.push(`required secrets unset: ${unset.join(', ')}`);
  }
  const duplicates = Object.keys(options.activities).filter((name) =>
    Object.hasOwn(options.agentActivities, name),
  );
  if (duplicates.length > 0) {
    problems.push(
      `activities named as a connected agent's: ${duplicates.join(', ')}`,
    );
  }
  const workflowBundlePath = fileURLToPath(options.workflowBundle);
  if (!existsSync(workflowBundlePath)) {
    problems.push(
      `the workflow bundle ${workflowBundlePath} is missing: build it with the project's \`bundle-workflows\` target`,
    );
  }
  let connect: ReturnType<typeof temporalConnectConfig> | undefined;
  try {
    connect = temporalConnectConfig(environment);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (problems.length > 0 || connect === undefined) {
    throw new Error(`the worker cannot start: ${problems.join('; ')}`);
  }
  const connection = await NativeConnection.connect(connect.connectionOptions);
  try {
    const worker = await Worker.create({
      connection,
      namespace: connect.namespace,
      taskQueue: options.taskQueue,
      workflowBundle: { codePath: workflowBundlePath },
      activities: { ...options.activities, ...options.agentActivities },
      shutdownGraceTime:
        options.shutdownGraceTime ?? DEFAULT_SHUTDOWN_GRACE_TIME,
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
