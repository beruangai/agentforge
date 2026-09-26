import { type ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ResourceInUseException,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  cause,
  isTerminal,
  type TaskState as TaskStateName,
  TERMINAL_TASK_STATES,
} from '#core/contract/task.ts';
import { OPERATIONAL_METRICS } from '#core/metrics.ts';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { finishedTask, stateOf } from './a2a-task.ts';
import type { OperationalMetrics } from './metrics.ts';

/** A task whose lease has not been renewed for this long is lost (§REQ303). */
export const LEASE_MILLISECONDS = 60_000;
/** How long a task, and the idempotency key naming it, are kept. */
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * A2A's task store over one DynamoDB table keyed by `pk`, extended with what
 * the protocol has no place for: a lease the executor renews while the task
 * process lives, from which loss is derived at read time, and an index from
 * idempotency key to the latest attempt.
 *
 * A terminal state is final. Every write is conditional on the stored task not
 * being terminal, so a container finishing a task that another reader already
 * derived lost cannot overwrite it — the later write is refused, not raced.
 */
export class DynamoDBTaskStore implements TaskStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;

  readonly #metrics: OperationalMetrics;
  constructor(
    client: DynamoDBClient,
    tableName: string,
    metrics: OperationalMetrics,
  ) {
    this.#client = client;
    this.#tableName = tableName;
    this.#metrics = metrics;
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const state = stateOf(task);
    const now = Date.now();
    try {
      await this.#client.send(
        new UpdateItemCommand({
          TableName: this.#tableName,
          Key: { pk: { S: taskKey(task.id) } },
          UpdateExpression: isTerminal(state)
            ? 'SET #task = :task, #state = :state, expiresAt = :expiresAt REMOVE leaseExpiresAt'
            : 'SET #task = :task, #state = :state, expiresAt = :expiresAt, leaseExpiresAt = :lease',
          // A repeat of the same end is allowed: the executor saves the final
          // task itself, and the A2A SDK then saves its own copy of it.
          ConditionExpression: `attribute_not_exists(#state) OR NOT (#state IN (${TERMINAL_PLACEHOLDERS})) OR #state = :state`,
          ExpressionAttributeNames: { '#task': 'task', '#state': 'state' },
          ExpressionAttributeValues: {
            ':task': { S: JSON.stringify(Task.toJSON(task)) },
            ':state': { S: state },
            ':expiresAt': {
              N: String(Math.floor(now / 1000) + RETENTION_SECONDS),
            },
            ...(isTerminal(state)
              ? {}
              : { ':lease': { N: String(now + LEASE_MILLISECONDS) } }),
            ...TERMINAL_VALUES,
          },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new Error(
          `task ${task.id} already ended; the write of ${state} was refused`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** The task, with loss derived: a live task whose lease lapsed is failed `LOST`. */
  async load(
    taskId: string,
    _context?: ServerCallContext,
  ): Promise<Task | undefined> {
    const item = await this.readTaskItem(taskId);
    if (item === undefined) return undefined;
    if (isTerminal(item.state) || item.leaseExpiresAt > Date.now())
      return item.task;
    const lost = finishedTask(item.task, {
      state: 'TASK_STATE_FAILED',
      cause: cause(
        'LOST',
        'the task process stopped renewing its lease: its container died or was stopped',
      ),
    });
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            pk: { S: taskKey(taskId) },
            task: { S: JSON.stringify(Task.toJSON(lost)) },
            state: { S: 'TASK_STATE_FAILED' },
            expiresAt: {
              N: String(Math.floor(Date.now() / 1000) + RETENTION_SECONDS),
            },
          },
          ConditionExpression: '#state = :state AND leaseExpiresAt = :lease',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':state': { S: item.state },
            ':lease': { N: String(item.leaseExpiresAt) },
          },
        }),
      );
      this.#metrics.count(OPERATIONAL_METRICS.LOST, taskId);
      return lost;
    } catch (error) {
      // Someone wrote first — a renewal or the real outcome. Read what they wrote.
      if (error instanceof ConditionalCheckFailedException) {
        return (await this.readTaskItem(taskId))?.task;
      }
      throw error;
    }
  }

  /** Not served: a caller holds its own task ids, and nothing here needs a listing. */
  async list(): Promise<ListTasksResponse> {
    throw new Error('ListTasks is not supported by AgentForge');
  }

  async renewLease(taskId: string): Promise<void> {
    await this.#client.send(
      new UpdateItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: taskKey(taskId) } },
        UpdateExpression: 'SET leaseExpiresAt = :lease',
        ConditionExpression: `attribute_exists(pk) AND NOT (#state IN (${TERMINAL_PLACEHOLDERS}))`,
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':lease': { N: String(Date.now() + LEASE_MILLISECONDS) },
          ...TERMINAL_VALUES,
        },
      }),
    );
  }

  /** The latest task started under an idempotency key. */
  async taskIdForKey(idempotencyKey: string): Promise<string | undefined> {
    const response = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: idempotencyKeyKey(idempotencyKey) } },
        ConsistentRead: true,
      }),
    );
    return response.Item?.taskId?.S;
  }

  /**
   * Points a key at a new attempt — only if it still points where the caller
   * read it, so two starts racing cannot both win.
   */
  async bindKey(
    idempotencyKey: string,
    taskId: string,
    previousTaskId: string | undefined,
  ): Promise<void> {
    await this.#client.send(
      new PutItemCommand({
        TableName: this.#tableName,
        Item: {
          pk: { S: idempotencyKeyKey(idempotencyKey) },
          taskId: { S: taskId },
          expiresAt: {
            N: String(Math.floor(Date.now() / 1000) + RETENTION_SECONDS),
          },
        },
        ConditionExpression:
          previousTaskId === undefined
            ? 'attribute_not_exists(pk)'
            : 'taskId = :previous',
        ...(previousTaskId === undefined
          ? {}
          : {
              ExpressionAttributeValues: { ':previous': { S: previousTaskId } },
            }),
      }),
    );
  }

  private async readTaskItem(
    taskId: string,
  ): Promise<
    { task: Task; state: TaskStateName; leaseExpiresAt: number } | undefined
  > {
    const response = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: taskKey(taskId) } },
        ConsistentRead: true,
      }),
    );
    const item = response.Item;
    if (item === undefined) return undefined;
    const serialised = item.task?.S;
    const state = item.state?.S;
    if (serialised === undefined || state === undefined) {
      throw new Error(`task ${taskId} is stored without its task or state`);
    }
    return {
      task: Task.fromJSON(JSON.parse(serialised)),
      state: state as TaskStateName,
      leaseExpiresAt: Number(item.leaseExpiresAt?.N ?? 0),
    };
  }
}

const TERMINAL_STATES = [...TERMINAL_TASK_STATES];
const TERMINAL_PLACEHOLDERS = TERMINAL_STATES.map(
  (_, index) => `:terminal${index}`,
).join(', ');
const TERMINAL_VALUES = Object.fromEntries(
  TERMINAL_STATES.map((state, index) => [`:terminal${index}`, { S: state }]),
);

function taskKey(taskId: string): string {
  return `task#${taskId}`;
}

function idempotencyKeyKey(idempotencyKey: string): string {
  return `key#${idempotencyKey}`;
}

/**
 * Creates the table the store expects unless it exists — for local
 * development and tests. In the cloud the CDK construct owns it.
 */
export async function createTaskTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: TASK_TABLE_PARTITION_KEY, AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: TASK_TABLE_PARTITION_KEY, KeyType: 'HASH' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (error) {
    // Already there: whoever created it owns its configuration.
    if (error instanceof ResourceInUseException) return;
    throw error;
  }
  // TTL cannot be set on a table still CREATING.
  await waitUntilTableExists(
    { client, maxWaitTime: 120 },
    { TableName: tableName },
  );
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: {
        AttributeName: TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
        Enabled: true,
      },
    }),
  );
}
