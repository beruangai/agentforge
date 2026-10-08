import { setTimeout as delay } from 'node:timers/promises';
import {
  Artifact,
  type ListTasksResponse,
  type Message,
  Task,
} from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import {
  type AttributeValue,
  ConditionalCheckFailedException,
  CreateTableCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ResourceInUseException,
  TransactionCanceledException,
  type TransactWriteItem,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  cause,
  isTerminal,
  type TaskState,
  TaskStateEnum,
  TERMINAL_TASK_STATES,
} from '#core/contract/task.ts';
import { OPERATIONAL_METRICS } from '#core/metrics.ts';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { finishedTask, readEnvelope, stateOf } from './a2a-task.ts';
import type { OperationalMetrics } from './metrics.ts';

/** A task whose lease has not been renewed for this long is lost (§REQ303). */
export const LEASE_MILLISECONDS = 60_000;
/** How long a task, and the idempotency key naming it, are kept. */
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
/** How many times a transaction cancelled by a concurrent write is tried. */
const TRANSACTION_ATTEMPTS = 3;
const TRANSACTION_RETRY_MILLISECONDS = 50;

/**
 * A2A's task store over one DynamoDB table keyed by `pk`, extended with what
 * the protocol has no place for: a lease the executor renews while the task
 * process lives, from which loss is derived at read time, and an index from
 * idempotency key to the latest attempt.
 *
 * The table is a project's, shared by its agents, and a store is one agent's
 * (ADR 0006): every task record it writes names its agent, a task another
 * agent recorded reads as absent, and an idempotency key binds per agent. A
 * task is keyed by its id alone.
 *
 * A task is three records, so a large input or outcome cannot push it past
 * DynamoDB's 400 KB item: `task#id`, the task without its history or
 * artifacts, with its state and lease; `input#id`, the message that started
 * it, less the metadata and tags the task record holds, written once and
 * kept for the record — nothing reads it back; and
 * `output#id`, its artifacts, which exist once it has ended and are written
 * in one transaction with its terminal state. A task loads without history:
 * the A2A SDK merges and appends to it, but nothing in AgentForge reads it —
 * the client reads artifacts and metadata only.
 *
 * A terminal state is final. Every write is conditional on the stored task not
 * being terminal, so a container finishing a task that another reader already
 * derived lost cannot overwrite it — the later write is refused, not raced. A
 * derived loss is marked, so not even a failure of the same state replaces it.
 */
export class DynamoDBTaskStore implements TaskStore {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;
  readonly #agentName: string;
  readonly #metrics: OperationalMetrics;

  constructor(
    client: DynamoDBClient,
    tableName: string,
    agentName: string,
    metrics: OperationalMetrics,
  ) {
    this.#client = client;
    this.#tableName = tableName;
    this.#agentName = agentName;
    this.#metrics = metrics;
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const state = stateOf(task);
    if (isTerminal(state) !== task.artifacts.length > 0) {
      throw new Error(
        `task ${task.id} is saved ${state} with ${task.artifacts.length} artifacts: an ended task carries its outcome, and a live one none`,
      );
    }
    const now = Date.now();
    const expiresAt = expiresAtOf(now);
    const items: TransactWriteItem[] = [
      {
        Update: {
          TableName: this.#tableName,
          Key: { pk: { S: taskKey(task.id) } },
          UpdateExpression: isTerminal(state)
            ? 'SET #task = :task, #state = :state, #agent = :agent, expiresAt = :expiresAt REMOVE leaseExpiresAt'
            : 'SET #task = :task, #state = :state, #agent = :agent, expiresAt = :expiresAt, leaseExpiresAt = :lease',
          // A repeat of the same end is allowed: the executor saves the final
          // task itself, and the A2A SDK then saves its own copy of it. A
          // derived loss is never replaced, whatever the write.
          ConditionExpression: `(attribute_not_exists(#state) OR NOT (#state IN (${TERMINAL_PLACEHOLDERS})) OR #state = :state) AND attribute_not_exists(#derivedLost)`,
          ExpressionAttributeNames: {
            '#task': 'task',
            '#state': 'state',
            '#agent': AGENT_ATTRIBUTE,
            '#derivedLost': DERIVED_LOST_ATTRIBUTE,
          },
          ExpressionAttributeValues: {
            ':task': { S: taskRecordOf(task) },
            ':state': { S: state },
            ':agent': { S: this.#agentName },
            ':expiresAt': expiresAt,
            ...(isTerminal(state)
              ? {}
              : { ':lease': { N: String(now + LEASE_MILLISECONDS) } }),
            ...TERMINAL_VALUES,
          },
        },
      },
    ];
    // The SDK saves a task SUBMITTED once, first, with the message that started it.
    if (state === 'TASK_STATE_SUBMITTED') {
      const [message, ...more] = task.history;
      if (message === undefined || more.length > 0) {
        throw new Error(
          `task ${task.id} is saved SUBMITTED with ${task.history.length} messages, not the one that started it`,
        );
      }
      items.push({
        Put: {
          TableName: this.#tableName,
          Item: {
            pk: { S: inputKey(task.id) },
            envelope: { S: taskInput(message) },
            expiresAt,
          },
        },
      });
    }
    if (isTerminal(state)) {
      items.push(this.#outputPut(task, expiresAt));
    }
    try {
      await this.#transact(items);
    } catch (error) {
      if (cancelledFor(error, 'ConditionalCheckFailed')) {
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
    const item = await this.readTask(taskId);
    if (item === undefined) return undefined;
    if (isTerminal(item.state)) return item.task;
    if (item.leaseExpiresAt === undefined) {
      throw new Error(`task ${taskId} is stored live without a lease`);
    }
    if (item.leaseExpiresAt > Date.now()) return item.task;
    const lost = finishedTask(item.task, {
      state: 'TASK_STATE_FAILED',
      cause: cause(
        'LOST',
        'the task process stopped renewing its lease: its container died or was stopped',
      ),
    });
    const expiresAt = expiresAtOf(Date.now());
    try {
      await this.#transact([
        {
          Put: {
            TableName: this.#tableName,
            Item: {
              pk: { S: taskKey(taskId) },
              task: { S: taskRecordOf(lost) },
              state: { S: 'TASK_STATE_FAILED' },
              [AGENT_ATTRIBUTE]: { S: this.#agentName },
              [DERIVED_LOST_ATTRIBUTE]: { BOOL: true },
              expiresAt,
            },
            ConditionExpression: '#state = :state AND leaseExpiresAt = :lease',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':state': { S: item.state },
              ':lease': { N: String(item.leaseExpiresAt) },
            },
          },
        },
        this.#outputPut(lost, expiresAt),
      ]);
      this.#metrics.count(OPERATIONAL_METRICS.LOST, taskId);
      return lost;
    } catch (error) {
      // Someone wrote first — a renewal or the real outcome. Read what they wrote.
      if (cancelledFor(error, 'ConditionalCheckFailed')) {
        return (await this.readTask(taskId))?.task;
      }
      throw error;
    }
  }

  /** Not served: a caller holds its own task ids, and nothing here needs a listing. */
  async list(): Promise<ListTasksResponse> {
    throw new Error('ListTasks is not supported by AgentForge');
  }

  /**
   * Pushes the lease forward. False when the stored task has already ended —
   * derived lost, most likely — or is gone: the task must not run on.
   */
  async renewLease(taskId: string): Promise<boolean> {
    try {
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
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  /** The latest task this agent started under an idempotency key. */
  async taskIdForKey(idempotencyKey: string): Promise<string | undefined> {
    const response = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: this.#idempotencyKeyKey(idempotencyKey) } },
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
          pk: { S: this.#idempotencyKeyKey(idempotencyKey) },
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

  /**
   * The task record, and for an ended task its output record's artifacts;
   * none for a task another agent of the project recorded.
   */
  private async readTask(
    taskId: string,
  ): Promise<
    | { task: Task; state: TaskState; leaseExpiresAt: number | undefined }
    | undefined
  > {
    const item = await this.#get(taskKey(taskId));
    if (item === undefined) return undefined;
    const serialised = item.task?.S;
    const stateValue = item.state?.S;
    const agentName = item[AGENT_ATTRIBUTE]?.S;
    if (
      serialised === undefined ||
      stateValue === undefined ||
      agentName === undefined
    ) {
      throw new Error(
        `task ${taskId} is stored without its task, state or agent`,
      );
    }
    if (agentName !== this.#agentName) return undefined;
    const state = TaskStateEnum.parse(stateValue);
    const task = Task.fromJSON(JSON.parse(serialised));
    if (isTerminal(state)) {
      const artifacts = (await this.#get(outputKey(taskId)))?.artifacts?.S;
      if (artifacts === undefined) {
        throw new Error(
          `task ${taskId} ended ${state} without its output record`,
        );
      }
      task.artifacts = (JSON.parse(artifacts) as unknown[]).map((artifact) =>
        Artifact.fromJSON(artifact),
      );
    }
    return {
      task,
      state,
      leaseExpiresAt:
        item.leaseExpiresAt?.N === undefined
          ? undefined
          : Number(item.leaseExpiresAt.N),
    };
  }

  /** An idempotency key's binding: one per agent, as it names one execution of the agent it was sent to. */
  #idempotencyKeyKey(idempotencyKey: string): string {
    return `key#${this.#agentName}#${idempotencyKey}`;
  }

  async #get(pk: string): Promise<Record<string, AttributeValue> | undefined> {
    const response = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      }),
    );
    return response.Item;
  }

  #outputPut(task: Task, expiresAt: AttributeValue): TransactWriteItem {
    return {
      Put: {
        TableName: this.#tableName,
        Item: {
          pk: { S: outputKey(task.id) },
          artifacts: {
            S: JSON.stringify(
              task.artifacts.map((artifact) => Artifact.toJSON(artifact)),
            ),
          },
          expiresAt,
        },
      },
    };
  }

  /**
   * Writes the items as one. A transaction that meets a concurrent write to
   * one of its items — a lease renewal, most often — is cancelled without
   * effect, and the AWS SDK does not retry it: it is retried here.
   */
  async #transact(items: TransactWriteItem[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#client.send(
          new TransactWriteItemsCommand({ TransactItems: items }),
        );
        return;
      } catch (error) {
        const conflicted =
          cancelledFor(error, 'TransactionConflict') &&
          !cancelledFor(error, 'ConditionalCheckFailed');
        if (!conflicted || attempt >= TRANSACTION_ATTEMPTS) throw error;
        await delay(TRANSACTION_RETRY_MILLISECONDS * attempt);
      }
    }
  }
}

/**
 * The input record's content: the envelope that started a task, less its
 * metadata and tags, which are the task's and live in the task record.
 */
function taskInput(message: Message): string {
  const { metadata: _metadata, tags: _tags, ...input } = readEnvelope(message);
  return JSON.stringify(input);
}

/** The task record's task: its history is the input record's, its artifacts the output record's. */
function taskRecordOf(task: Task): string {
  return JSON.stringify(Task.toJSON({ ...task, history: [], artifacts: [] }));
}

function expiresAtOf(now: number): AttributeValue {
  return { N: String(Math.floor(now / 1000) + RETENTION_SECONDS) };
}

function cancelledFor(error: unknown, code: string): boolean {
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === code)
  );
}

/** Names the agent whose task a task record is. */
const AGENT_ATTRIBUTE = 'agent';

/** Marks a loss derived by a reader, which no later write replaces. */
const DERIVED_LOST_ATTRIBUTE = 'derivedLost';

const TERMINAL_PLACEHOLDERS = TERMINAL_TASK_STATES.map(
  (_, index) => `:terminal${index}`,
).join(', ');
const TERMINAL_VALUES = Object.fromEntries(
  TERMINAL_TASK_STATES.map((state, index) => [
    `:terminal${index}`,
    { S: state },
  ]),
);

function taskKey(taskId: string): string {
  return `task#${taskId}`;
}

function inputKey(taskId: string): string {
  return `input#${taskId}`;
}

function outputKey(taskId: string): string {
  return `output#${taskId}`;
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
