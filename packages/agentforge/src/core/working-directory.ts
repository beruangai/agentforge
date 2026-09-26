/**
 * The working directories an agent may open, as `{ name: bucket }` JSON, named
 * by the `AgentRuntime` construct and read by the harness (ADR 0015).
 */
export const WORKING_DIRECTORIES_VARIABLE = 'AGENTFORGE_WORKING_DIRECTORIES';

/** A working directory's name: what a procedure opens it by. */
export const WORKING_DIRECTORY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
