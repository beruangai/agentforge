/**
 * Set by the `AgentRuntime` construct to the runtime's container URI, and by
 * `serve` to the agent image's id, and read by the server: the image a task
 * runs in, recorded on the task when it is admitted (§REQ601).
 */
export const AGENT_IMAGE_VARIABLE = 'AGENTFORGE_AGENT_IMAGE';
