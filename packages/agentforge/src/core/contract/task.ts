import { z } from 'zod';

/**
 * A task's state is A2A 1.0's, verbatim. AgentForge adds no state of its own;
 * a failed task carries a typed cause instead.
 */
export const TASK_STATES = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
] as const;
export const TaskStateEnum = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateEnum>;

export const TERMINAL_TASK_STATES = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
] as const satisfies ReadonlyArray<TaskState>;
export const TerminalTaskStateEnum = z.enum(TERMINAL_TASK_STATES);
export type TerminalTaskState = z.infer<typeof TerminalTaskStateEnum>;

export function isTerminal(state: TaskState): state is TerminalTaskState {
  return TerminalTaskStateEnum.safeParse(state).success;
}

/** Why a task failed. The code is what a caller branches on. */
export const CAUSE_CODES = [
  /** The agent's answer did not conform, or there was none. `payload` holds what arrived. */
  'OUTPUT_INVALID',
  /** The outcome conformed but exceeds the record's cap; return references instead. */
  'OUTPUT_TOO_LARGE',
  /** `maxTurns` or `maxBudgetUsd` ran out. */
  'BUDGET_EXHAUSTED',
  /** The task's own time budget ran out; the executor stopped it. */
  'TIMED_OUT',
  /** The container died or was stopped mid-run; side effects may have happened. */
  'LOST',
  /** The subscription's usage limit; `retryAfter` is when it resets. */
  'USAGE_LIMITED',
  /** The subscription token was refused; an operator must act. */
  'CREDENTIAL_EXPIRED',
  /** The model provider failed transiently. */
  'PROVIDER_TRANSIENT',
  /** A filesystem could not be mounted, or its push not verified: the task's files are not all where they belong. */
  'FILESYSTEM_UNSYNCED',
  /** Anything else: the procedure, the harness or the SDK threw. */
  'EXECUTION_ERROR',
] as const;
export const CauseCodeEnum = z.enum(CAUSE_CODES);
export type CauseCode = z.infer<typeof CauseCodeEnum>;

export const CauseSchema = z.object({
  code: CauseCodeEnum,
  message: z.string(),
  /** What would resolve it: the first thing to try. */
  suggestedAction: z.string(),
  /** Whether running a new attempt could succeed. */
  retryable: z.boolean(),
  /** ISO time before which a retry is pointless. */
  retryAfter: z.iso.datetime().optional(),
  /** What the agent produced, when it did not conform. */
  payload: z.unknown().optional(),
  /**
   * The error behind it, with its stack and cause chain, cut to
   * `STACK_TRACE_CAP_BYTES`. The container log holds it whole.
   */
  stackTrace: z.string().optional(),
});
export type Cause = z.infer<typeof CauseSchema>;

const RETRYABLE_BY_CODE: Record<CauseCode, boolean> = {
  OUTPUT_INVALID: false,
  OUTPUT_TOO_LARGE: false,
  BUDGET_EXHAUSTED: false,
  TIMED_OUT: false,
  LOST: true,
  USAGE_LIMITED: true,
  CREDENTIAL_EXPIRED: false,
  PROVIDER_TRANSIENT: true,
  FILESYSTEM_UNSYNCED: true,
  EXECUTION_ERROR: false,
};

const SUGGESTED_ACTION_BY_CODE: Record<CauseCode, string> = {
  OUTPUT_INVALID:
    'Compare `payload` with the agent contract. A contract the agent keeps missing usually asks too much of one answer: flatten or split it, and say what each field means in the prompt or with `.describe()` (§REQ102, §REQ103).',
  OUTPUT_TOO_LARGE:
    "Keep the outer contract to what the caller branches on — identifiers, verdicts, references. Write bulk results where the caller can read them (a file, object storage) and return a reference; never the agent's whole output (§REQ102, ADR 0006).",
  BUDGET_EXHAUSTED:
    'Raise `maxTurns` or `maxBudgetUsd` for the procedure, or narrow what the prompt asks for.',
  TIMED_OUT:
    "Raise the procedure's time budget — `timeBudget(seconds)` in its contract, or per call — or narrow what the prompt asks for (§REQ202).",
  LOST: 'Reconcile any side effects the attempt may have made, then retry under the same idempotency key; the next attempt receives this one as `priorAttempt` (§REQ303, §REQ503).',
  USAGE_LIMITED:
    "Retry after `retryAfter`, when the subscription's usage limit resets.",
  CREDENTIAL_EXPIRED:
    "An operator renews the subscription token (`claude setup-token`) and updates the agent's secret; a retry cannot succeed before that (§REQ705).",
  PROVIDER_TRANSIENT: 'Retry with backoff.',
  FILESYSTEM_UNSYNCED:
    "Retry: the filesystem's store failed or disagreed. A push may have landed part of this attempt's files; the next attempt receives this one as `priorAttempt` (ADR 0015).",
  EXECUTION_ERROR:
    'Read `stackTrace`, and the container log for the whole error; fix the procedure, its options, or the layer that threw.',
};

/** The most of a stack trace a cause carries. */
export const STACK_TRACE_CAP_BYTES = 4 * 1024;

export function cause(
  code: CauseCode,
  message: string,
  extra: Partial<
    Pick<Cause, 'retryAfter' | 'payload' | 'suggestedAction' | 'stackTrace'>
  > = {},
): Cause {
  return {
    code,
    message,
    suggestedAction: SUGGESTED_ACTION_BY_CODE[code],
    retryable: RETRYABLE_BY_CODE[code],
    ...extra,
    ...(extra.stackTrace === undefined
      ? {}
      : { stackTrace: truncate(extra.stackTrace, STACK_TRACE_CAP_BYTES) }),
  };
}

/** Cut to at most `capBytes` of UTF-8, saying so. */
function truncate(text: string, capBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= capBytes) return text;
  const marker = `\n… cut at ${capBytes} of ${encoded.byteLength} bytes`;
  const kept = new TextDecoder()
    .decode(encoded.subarray(0, capBytes - encoder.encode(marker).byteLength))
    .replace(/\uFFFD$/, '');
  return kept + marker;
}

/** How a task ended, as the task process reports it and the artifact carries it. */
export const OutcomeSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal(TaskStateEnum.enum.TASK_STATE_COMPLETED),
    output: z.unknown(),
  }),
  z.object({
    state: z.literal(TaskStateEnum.enum.TASK_STATE_FAILED),
    cause: CauseSchema,
  }),
  z.object({ state: z.literal(TaskStateEnum.enum.TASK_STATE_CANCELED) }),
  z.object({
    state: z.literal(TaskStateEnum.enum.TASK_STATE_REJECTED),
    reason: z.string(),
  }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** The artifact a finished task carries its outcome in, as its one data part (ADR 0002). */
export const OUTCOME_ARTIFACT_ID = 'outcome';

/** Artifacts as A2A 1.0 JSON carries them — absent when there are none. */
const WireArtifactsSchema = z
  .array(
    z.looseObject({
      artifactId: z.string(),
      parts: z.array(z.looseObject({ data: z.unknown().optional() })),
    }),
  )
  .optional();

/**
 * A task's outcome, read from its artifacts in their A2A 1.0 JSON form: the
 * one data part of the `outcome` artifact, or none while the task runs.
 * Shared by the server, which writes it, and the client, which reads it.
 */
export function outcomeOfArtifacts(artifacts: unknown): Outcome | undefined {
  const artifact = WireArtifactsSchema.parse(artifacts)?.find(
    (candidate) => candidate.artifactId === OUTCOME_ARTIFACT_ID,
  );
  if (artifact === undefined) return undefined;
  const dataParts = artifact.parts.filter((part) => 'data' in part);
  const [part] = dataParts;
  if (dataParts.length !== 1 || part === undefined) {
    throw new Error(
      `the outcome artifact carries ${dataParts.length} data parts, not one`,
    );
  }
  return OutcomeSchema.parse(part.data);
}

/** What one agent run recorded (§REQ601). */
export const RunRecordSchema = z.object({
  /** The prompt as sent, hashed; the container log and the transcript hold it whole. */
  promptHash: z.string(),
  promptBytes: z.number(),
  options: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional(),
  numberOfTurns: z.number().optional(),
  totalCostUsd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  durationMilliseconds: z.number().optional(),
  terminalReason: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The attempt before this one under the same idempotency key, if any. */
export const PriorAttemptSchema = z.object({
  taskId: z.string(),
  state: TaskStateEnum,
  cause: CauseSchema.optional(),
});
export type PriorAttempt = z.infer<typeof PriorAttemptSchema>;
