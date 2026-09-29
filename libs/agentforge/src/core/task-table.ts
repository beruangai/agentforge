/**
 * The task table's definition, shared by the runtime's task store, which creates it for
 * local runs, and the `AgentRuntime` construct, which deploys it — so the two
 * cannot drift. Imports nothing, so the construct pulls in no DynamoDB client.
 */
export const TASK_TABLE_PARTITION_KEY = 'pk';
/** Every item carries its expiry here; DynamoDB's TTL deletes it. */
export const TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE = 'expiresAt';
/** Set by the construct to the table's name: where the server keeps task state. */
export const TASK_TABLE_NAME_VARIABLE = 'AGENTFORGE_TABLE_NAME';
/**
 * The most a start's envelope may hold, so both records it is stored across —
 * the input record, and the task record's metadata and tags — stay under
 * DynamoDB's 400 KB item: a start over it is rejected.
 */
export const TASK_INPUT_CAP_BYTES = 350 * 1024;
/**
 * The most a task's outcome may hold, so its output record fits the same
 * item: a larger output fails `OUTPUT_TOO_LARGE`, and a larger cause loses its payload.
 */
export const TASK_OUTPUT_CAP_BYTES = 350 * 1024;
