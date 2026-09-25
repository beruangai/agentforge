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
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
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
  /** Anything else: the procedure, the harness or the SDK threw. */
  'EXECUTION_ERROR',
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];

export const CauseSchema = z.object({
  code: z.enum(CAUSE_CODES),
  message: z.string(),
  /** Whether running a new attempt could succeed. */
  retryable: z.boolean(),
  /** ISO time before which a retry is pointless. */
  retryAfter: z.string().optional(),
  /** What the agent produced, when it did not conform. */
  payload: z.unknown().optional(),
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
  EXECUTION_ERROR: false,
};

export function cause(
  code: CauseCode,
  message: string,
  extra: Partial<Pick<Cause, 'retryAfter' | 'payload'>> = {},
): Cause {
  return { code, message, retryable: RETRYABLE_BY_CODE[code], ...extra };
}

/** How a task ended, as the task process reports it and the artifact carries it. */
export const OutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('TASK_STATE_COMPLETED'), output: z.unknown() }),
  z.object({ state: z.literal('TASK_STATE_FAILED'), cause: CauseSchema }),
  z.object({ state: z.literal('TASK_STATE_CANCELED') }),
  z.object({ state: z.literal('TASK_STATE_REJECTED'), reason: z.string() }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** What one agent run recorded (§REQ601). */
export const RunRecordSchema = z.object({
  prompt: z.unknown(),
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
  state: z.enum(TASK_STATES),
  cause: CauseSchema.optional(),
});
export type PriorAttempt = z.infer<typeof PriorAttemptSchema>;
