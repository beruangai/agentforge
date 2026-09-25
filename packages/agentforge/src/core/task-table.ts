/**
 * The task table's definition, shared by the runtime's task store, which creates it for
 * local runs, and the `AgentRuntime` construct, which deploys it — so the two
 * cannot drift. Imports nothing, so the construct pulls in no DynamoDB client.
 */
export const TASK_TABLE_PARTITION_KEY = 'pk';
/** Every item carries its expiry here; DynamoDB's TTL deletes it. */
export const TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE = 'expiresAt';
