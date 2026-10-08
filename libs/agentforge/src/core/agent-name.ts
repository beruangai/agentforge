/**
 * Set by the `AgentRuntime` construct, and by an agent's generated
 * Dockerfile for local serving, and read by the server: the agent's name
 * within its project, which its tasks and transcripts are scoped by.
 */
export const AGENT_NAME_VARIABLE = 'AGENTFORGE_AGENT_NAME';

/**
 * A project's or an agent's name: kebab-case, which every name derived from
 * it stays valid as — a key prefix, a construct id, a dashboard title.
 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
