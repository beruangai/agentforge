import { z } from 'zod';
import { EnvelopeSchema } from '../contract/envelope.ts';
import {
  OutcomeSchema,
  PriorAttemptSchema,
  RunRecordSchema,
} from '../contract/task.ts';

/**
 * The task-process protocol: the executor and the process it spawns for one
 * task speak over Node's IPC channel, so nothing the task writes to stdout
 * can be mistaken for a message. One `run` in; any number of `record`s and
 * exactly one `outcome` out; a `cancel` may arrive at any time. Each side
 * parses every message it receives.
 */
export const TaskInvocationSchema = z.object({
  taskId: z.string(),
  contextId: z.string(),
  runtimeSessionId: z.string(),
  attempt: z.number().int().positive(),
  priorAttempt: PriorAttemptSchema.optional(),
  envelope: EnvelopeSchema,
});
export type TaskInvocation = z.infer<typeof TaskInvocationSchema>;

export const ExecutorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), invocation: TaskInvocationSchema }),
  z.object({ type: z.literal('cancel') }),
]);
export type ExecutorMessage = z.infer<typeof ExecutorMessageSchema>;

export const TaskProcessMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record'), record: RunRecordSchema }),
  z.object({ type: z.literal('outcome'), outcome: OutcomeSchema }),
]);
export type TaskProcessMessage = z.infer<typeof TaskProcessMessageSchema>;

/** Set on a spawned task process so it knows to wait for a `run`. */
export const TASK_PROCESS_ENVIRONMENT_VARIABLE = 'AGENTFORGE_TASK_PROCESS';
