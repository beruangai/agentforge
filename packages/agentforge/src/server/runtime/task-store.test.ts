import type { Message, Task } from '@a2a-js/sdk';
import {
  type AttributeValue,
  GetItemCommand,
  TransactionCanceledException,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { finishedTask, newTask } from './a2a-task.ts';
import { ADMISSION_METADATA_KEY } from './executor.ts';
import { DynamoDBTaskStore } from './task-store.ts';

/**
 * The table as the store uses it, over a map. A transaction applies whole;
 * conditions are not evaluated — a refusal is scripted with a rejection.
 */
class FakeTable {
  readonly items = new Map<string, Record<string, AttributeValue>>();
  readonly transactions: TransactWriteItem[][] = [];
  readonly send = vi.fn(async (command: unknown) => {
    if (command instanceof GetItemCommand) {
      const pk = command.input.Key?.pk?.S ?? '';
      return { Item: this.items.get(pk) };
    }
    if (command instanceof TransactWriteItemsCommand) {
      const items = command.input.TransactItems ?? [];
      this.transactions.push(items);
      for (const item of items) this.apply(item);
      return {};
    }
    throw new Error(`the fake table does not serve ${String(command)}`);
  });

  private apply(item: TransactWriteItem): void {
    if (item.Put?.Item !== undefined) {
      this.items.set(item.Put.Item.pk?.S ?? '', item.Put.Item);
      return;
    }
    const update = item.Update;
    if (update === undefined) throw new Error('only Put and Update are served');
    const pk = update.Key?.pk?.S ?? '';
    const values = update.ExpressionAttributeValues ?? {};
    const { leaseExpiresAt: _removed, ...kept } = this.items.get(pk) ?? {};
    this.items.set(pk, {
      ...kept,
      pk: { S: pk },
      task: values[':task'] as AttributeValue,
      state: values[':state'] as AttributeValue,
      expiresAt: values[':expiresAt'] as AttributeValue,
      ...(values[':lease'] === undefined
        ? {}
        : { leaseExpiresAt: values[':lease'] }),
    });
  }
}

function store() {
  const table = new FakeTable();
  const metrics = { count: vi.fn(), flush: async () => undefined };
  return {
    table,
    metrics,
    store: new DynamoDBTaskStore(
      table as unknown as ConstructorParameters<typeof DynamoDBTaskStore>[0],
      'tasks',
      metrics,
    ),
  };
}

const startMessage: Message = {
  messageId: 'message',
  contextId: 'context',
  taskId: '',
  role: 1,
  parts: [
    {
      content: {
        $case: 'data',
        value: {
          procedure: 'summarise',
          contractHash: 'hash',
          input: 'the caller’s input',
          idempotencyKey: 'key',
          metadata: { caller: 'the task record’s' },
          tags: { kind: 'the task record’s' },
        },
      },
      filename: '',
      mediaType: '',
      metadata: undefined,
    },
  ],
  metadata: { [ADMISSION_METADATA_KEY]: { attempt: 2 } },
  extensions: [],
  referenceTaskIds: [],
};

function task(state: 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING'): Task {
  return {
    ...newTask({
      id: 'task',
      contextId: 'context',
      state,
      metadata: { attempt: 1 },
    }),
    history: [startMessage],
  };
}

const completed = finishedTask(task('TASK_STATE_WORKING'), {
  state: 'TASK_STATE_COMPLETED',
  output: { answer: 42 },
});

function conditionRefused(reason: string): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: reason }, { Code: 'None' }],
  });
}

describe('the task store', () => {
  it('keeps a task as three records — its input without the metadata and tags the task holds — and loads it whole, without history', async () => {
    const { store: tasks, table } = store();
    await tasks.save(task('TASK_STATE_SUBMITTED'));
    await tasks.save(task('TASK_STATE_WORKING'));
    await tasks.save(completed);
    expect([...table.items.keys()].sort()).toEqual([
      'input#task',
      'output#task',
      'task#task',
    ]);
    for (const item of table.items.values()) {
      expect(item.expiresAt?.N).toMatch(/^\d+$/);
    }
    const record = JSON.parse(table.items.get('task#task')?.task?.S ?? '');
    expect(record.history).toBeUndefined();
    expect(record.artifacts).toBeUndefined();
    const input = JSON.parse(table.items.get('input#task')?.envelope?.S ?? '');
    expect(input).toEqual({
      procedure: 'summarise',
      contractHash: 'hash',
      input: 'the caller’s input',
      idempotencyKey: 'key',
    });

    const loaded = await tasks.load('task');
    expect(loaded?.history).toEqual([]);
    expect(loaded?.artifacts).toEqual(completed.artifacts);
    expect(loaded?.metadata).toEqual({ attempt: 1 });
  });

  it('writes the input record once, with the submitted task', async () => {
    const { store: tasks, table } = store();
    await tasks.save(task('TASK_STATE_SUBMITTED'));
    await tasks.save(task('TASK_STATE_WORKING'));
    await tasks.save(completed);
    const inputPuts = table.transactions
      .flat()
      .filter((item) => item.Put?.Item?.pk?.S === 'input#task');
    expect(inputPuts).toHaveLength(1);
    expect(table.transactions[0]).toHaveLength(2);
  });

  it('writes the output in the transaction that ends the task, and nothing when it is refused', async () => {
    const { store: tasks, table } = store();
    await tasks.save(task('TASK_STATE_WORKING'));
    table.send.mockRejectedValueOnce(
      conditionRefused('ConditionalCheckFailed'),
    );
    await expect(tasks.save(completed)).rejects.toThrow(
      /task task already ended; the write of TASK_STATE_COMPLETED was refused/,
    );
    expect(table.items.has('output#task')).toBe(false);

    await tasks.save(completed);
    const ending = table.transactions.at(-1);
    expect(ending?.map((item) => Object.keys(item)[0])).toEqual([
      'Update',
      'Put',
    ]);
    expect(ending?.[0]?.Update?.ConditionExpression).toMatch(
      /attribute_not_exists\(#derivedLost\)/,
    );
    expect(ending?.[1]?.Put?.Item?.pk?.S).toBe('output#task');
  });

  it('retries a transaction a concurrent write cancelled', async () => {
    const { store: tasks, table } = store();
    table.send.mockRejectedValueOnce(conditionRefused('TransactionConflict'));
    await tasks.save(task('TASK_STATE_WORKING'));
    expect(table.send).toHaveBeenCalledTimes(2);
    expect(table.items.has('task#task')).toBe(true);
  });

  it('derives a lapsed task lost, writing its output with it', async () => {
    const { store: tasks, table, metrics } = store();
    await tasks.save(task('TASK_STATE_WORKING'));
    const stored = table.items.get('task#task');
    table.items.set('task#task', {
      ...stored,
      leaseExpiresAt: { N: String(Date.now() - 1) },
    });
    const lost = await tasks.load('task');
    expect(lost?.artifacts[0]?.parts[0]?.content).toMatchObject({
      value: { state: 'TASK_STATE_FAILED', cause: { code: 'LOST' } },
    });
    const derived = table.transactions.at(-1);
    expect(derived?.[0]?.Put?.Item?.derivedLost).toEqual({ BOOL: true });
    expect(derived?.[1]?.Put?.Item?.pk?.S).toBe('output#task');
    expect(metrics.count).toHaveBeenCalledOnce();
    // Read again: the output record answers, and nothing is written.
    expect((await tasks.load('task'))?.artifacts).toEqual(lost?.artifacts);
    expect(metrics.count).toHaveBeenCalledOnce();
  });

  it('refuses a task whose artifacts disagree with its state', async () => {
    const { store: tasks, table } = store();
    await expect(tasks.save({ ...completed, artifacts: [] })).rejects.toThrow(
      /an ended task carries its outcome/,
    );
    await expect(
      tasks.save({
        ...task('TASK_STATE_WORKING'),
        artifacts: completed.artifacts,
      }),
    ).rejects.toThrow(/a live one none/);
    expect(table.send).not.toHaveBeenCalled();
  });
});
