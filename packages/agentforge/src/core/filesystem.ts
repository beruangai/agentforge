/**
 * The S3 buckets an agent's filesystems may use, as `{ name: bucket }` JSON,
 * named by the `AgentRuntime` construct and read by the harness (ADR 0015).
 */
export const FILESYSTEM_BUCKETS_VARIABLE = 'AGENTFORGE_FILESYSTEM_BUCKETS';

/** A filesystem's or a bucket's name: what a procedure registers it by. */
export const FILESYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
