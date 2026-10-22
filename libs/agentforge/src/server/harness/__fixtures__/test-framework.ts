import type { Cause, RunRecord, RunUsage } from '#core/contract/task.ts';
import type { AgentRunSpec, Framework, FrameworkRunner } from '../framework.ts';
import { agentOptionsMiddleware } from '../framework.ts';
import { TaskCanceled, TaskFailure } from '../task-failure.ts';

/** A framework of the shared tests' own: options name the mounts, nothing more. */
export type TestTypes = {
  readonly content: never;
  readonly options: { readonly mounts?: string[] };
  readonly extras: object;
  readonly usage: { readonly turns: number };
};

/** What one scripted run ends with: the agent's answer, or a failure. */
export type ScriptedRun =
  | { readonly output: unknown }
  | { readonly failure: Cause };

export const TEST_USAGE: RunUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/**
 * A framework whose runs answer as scripted, in order, the last repeated: each
 * records, then parses its answer with the run's contract. Reports no cost.
 */
export function testFramework(script: readonly ScriptedRun[]): {
  readonly framework: Framework<TestTypes>;
  readonly runner: FrameworkRunner<TestTypes>;
  readonly calls: AgentRunSpec<TestTypes, unknown>[];
} {
  const calls: AgentRunSpec<TestTypes, unknown>[] = [];
  const runner: FrameworkRunner<TestTypes> = {
    runAgent: async (spec, environment) => {
      if (environment.signal.aborted) throw new TaskCanceled();
      calls.push(spec);
      const scripted = script[Math.min(calls.length, script.length) - 1];
      if (scripted === undefined) throw new Error('nothing is scripted');
      const record: RunRecord = {
        framework: { name: 'claude', fullName: 'test-framework' },
        promptHash: 'hash',
        promptBytes: 0,
        options: {},
        sessionId: 'session-1',
        usage: TEST_USAGE,
        rawUsage: { turns: 1 },
      };
      environment.onRecord(record);
      if ('failure' in scripted) throw new TaskFailure(scripted.failure);
      return {
        output: spec.output.parse(scripted.output),
        sessionId: 'session-1',
        usage: TEST_USAGE,
        rawUsage: { turns: 1 },
        record,
      };
    },
  };
  return {
    framework: {
      name: 'test',
      prepare: () => runner,
      agentOptionsMiddleware: agentOptionsMiddleware<TestTypes['options']>(
        (filesystems) => {
          const mounts = Object.values(filesystems).map(
            (mounted) => mounted.localPath,
          );
          return mounts.length === 0 ? {} : { mounts };
        },
      ),
    },
    runner,
    calls,
  };
}
