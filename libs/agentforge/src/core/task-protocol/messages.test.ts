import { describe, expect, it } from 'vitest';
import { ExecutorMessageSchema, TaskProcessMessageSchema } from './messages.ts';

const invocation = {
  taskId: 'task',
  contextId: 'context',
  runtimeSessionId: 'session',
  attempt: 1,
  envelope: {
    procedure: 'summarise',
    contractHash: 'hash',
    input: { text: 'a text' },
    idempotencyKey: 'key',
  },
};

describe('the task-process messages', () => {
  it('parse what each side sends', () => {
    expect(
      ExecutorMessageSchema.parse({ type: 'run', invocation }),
    ).toMatchObject({ type: 'run', invocation: { taskId: 'task' } });
    expect(ExecutorMessageSchema.parse({ type: 'cancel' })).toEqual({
      type: 'cancel',
    });
    expect(
      TaskProcessMessageSchema.parse({
        type: 'outcome',
        outcome: { state: 'TASK_STATE_CANCELED' },
      }),
    ).toEqual({ type: 'outcome', outcome: { state: 'TASK_STATE_CANCELED' } });
  });

  it('refuse anything outside the protocol', () => {
    expect(ExecutorMessageSchema.safeParse({ type: 'go' }).success).toBe(false);
    expect(
      ExecutorMessageSchema.safeParse({
        type: 'run',
        invocation: { ...invocation, attempt: 0 },
      }).success,
    ).toBe(false);
    expect(
      TaskProcessMessageSchema.safeParse({
        type: 'outcome',
        outcome: { state: 'TASK_STATE_FAILED' },
      }).success,
    ).toBe(false);
    expect(
      TaskProcessMessageSchema.safeParse({ type: 'record', record: {} })
        .success,
    ).toBe(false);
  });
});
