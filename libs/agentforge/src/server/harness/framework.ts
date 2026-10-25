import { os } from '@orpc/server';
import type { z } from 'zod';
import {
  cause,
  type PriorAttempt,
  type RunRecord,
  type RunUsage,
} from '#core/contract/task.ts';
import type { MountedFilesystem } from './filesystem/filesystem.ts';
import type { ContextBlock } from './prompt.ts';
import type { StopGuard } from './stop-guard.ts';
import { TaskFailure } from './task-failure.ts';

/**
 * What a framework — the agent SDK a project's runs go through (ADR 0021) —
 * fixes for its procedures' types.
 */
export interface FrameworkTypes {
  /** Prompt content beyond the shared string and context block. */
  readonly content: unknown;
  /** A run's own options. */
  readonly options: object;
  /** Spec fields of the framework's own, beside the shared ones. */
  readonly extras: object;
  /** The framework's own usage result, as it reports it. */
  readonly usage: unknown;
}

/** One piece of a prompt: shared content, or the framework's own. */
export type PromptContent<Content> = string | ContextBlock | Content;

/** What the agent is asked: one piece of content, or several in order. */
export type Prompt<Content> =
  | PromptContent<Content>
  | readonly PromptContent<Content>[];

export type AgentRunSpec<F extends FrameworkTypes, Output> = {
  /** What the agent is asked. */
  readonly prompt: Prompt<F['content']>;
  /** The agent contract: what the agent itself fills in (§REQ102). Its root must be an object. */
  readonly output: z.ZodType<Output>;
  /**
   * Opts in to sending a contract whose root is not an object nested under
   * one property, unwrapped before it is parsed. Off by default: such a root
   * is usually a contract to rewrite, not to wrap.
   */
  readonly wrapNonObjectOutput?: boolean;
  readonly options?: F['options'];
  /**
   * Checks the structured output must pass, beside the agent contract,
   * before it is accepted: run on each submission, every failure told to the
   * agent at once, in its turn (§REQ208).
   */
  readonly guardrails?: {
    readonly stop?: readonly StopGuard[];
  };
} & F['extras'];

/** The spec fields every framework takes; `Record` so a field added to the spec must be listed. */
const SHARED_RUN_SPEC_FIELDS: Record<
  keyof AgentRunSpec<
    { content: never; options: object; extras: object; usage: never },
    unknown
  >,
  true
> = {
  prompt: true,
  output: true,
  wrapNonObjectOutput: true,
  options: true,
  guardrails: true,
};

/**
 * Refuses a spec carrying a field the framework does not take, naming each,
 * so it fails rather than being dropped (§REQ201): a field from another
 * framework, or one of the framework's options set beside them, as `resume`
 * on `claude`. Each framework lists its own extras.
 */
export function refuseUnknownRunSpecFields(
  spec: object,
  framework: { readonly name: string; readonly extras: Record<string, true> },
): void {
  const unknown = Object.keys(spec).filter(
    (key) =>
      !Object.hasOwn(SHARED_RUN_SPEC_FIELDS, key) &&
      !Object.hasOwn(framework.extras, key),
  );
  if (unknown.length === 0) return;
  throw new TaskFailure(
    cause(
      'EXECUTION_ERROR',
      `a ${framework.name} run spec does not take ${unknown.map((key) => `\`${key}\``).join(', ')}; it takes ${[...Object.keys(SHARED_RUN_SPEC_FIELDS), ...Object.keys(framework.extras)].map((key) => `\`${key}\``).join(', ')}`,
      {
        suggestedAction:
          "Move each into the run's `options` if it is one of the framework's options, or remove it.",
      },
    ),
  );
}

export interface AgentRun<F extends FrameworkTypes, Output> {
  readonly output: Output;
  readonly sessionId: string;
  /** Token usage every framework reports; a run that answered reached the model. */
  readonly usage: RunUsage;
  /** The framework's own usage result, for the procedure to promote what it needs. */
  readonly rawUsage: F['usage'];
  readonly record: RunRecord;
}

/** What every procedure handler receives as its oRPC context. */
export interface TaskContext<F extends FrameworkTypes> {
  readonly taskId: string;
  readonly contextId: string;
  readonly runtimeSessionId: string;
  readonly idempotencyKey: string;
  /** 1 for the first attempt under this idempotency key. */
  readonly attempt: number;
  /** How the previous attempt under this key ended, for reconciling its side effects. */
  readonly priorAttempt: PriorAttempt | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  /** Aborted when the task is cancelled or times out. */
  readonly signal: AbortSignal;
  /** Runs the agent to a settled, typed answer. Throws to fail or cancel the task. */
  runAgent<Output>(spec: AgentRunSpec<F, Output>): Promise<AgentRun<F, Output>>;
  /** The filesystems mounted for this procedure, by the name it registered each under (ADR 0015). */
  readonly filesystems: Readonly<Record<string, MountedFilesystem>>;
  /**
   * The run options the framework derives from this task's mounts, to compose
   * into a run's own. Empty without mounts. AgentForge applies none of it:
   * the handler decides (ADR 0015).
   */
  readonly agentOptions: Readonly<Partial<F['options']>>;
}

/** What a run reports to, and is cancelled by. */
export interface RunEnvironment {
  readonly signal: AbortSignal;
  readonly onRecord: (record: RunRecord) => void;
}

export interface FrameworkRunner<F extends FrameworkTypes> {
  runAgent<Output>(
    spec: AgentRunSpec<F, Output>,
    environment: RunEnvironment,
  ): Promise<AgentRun<F, Output>>;
}

export interface Framework<F extends FrameworkTypes> {
  readonly name: string;
  /** Called once per task process, before its run: reads the environment it needs. */
  prepare(): FrameworkRunner<F>;
  /** Appended after the filesystem mount: the mounts become `context.agentOptions`. */
  readonly agentOptionsMiddleware: AgentOptionsMiddleware<F['options']>;
}

/**
 * The oRPC middleware a framework vends, from how it derives a run's options
 * from the mounts.
 */
export function agentOptionsMiddleware<Options extends object>(
  derive: (
    filesystems: Readonly<Record<string, MountedFilesystem>>,
  ) => Readonly<Partial<Options>>,
) {
  return os
    .$context<{
      readonly filesystems: Readonly<Record<string, MountedFilesystem>>;
    }>()
    .middleware(({ context, next }) =>
      next({ context: { agentOptions: derive(context.filesystems) } }),
    );
}

export type AgentOptionsMiddleware<Options extends object> = ReturnType<
  typeof agentOptionsMiddleware<Options>
>;
