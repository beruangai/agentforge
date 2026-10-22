/**
 * The Agent SDK version AgentForge pins (exact, pre-1.0) — the peer range in
 * the published manifest, which the image's frozen lock installs. A unit test
 * holds the two together, so nothing is read at run time.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.280';

/** The `claude` framework's full name on a run's record: its SDK and version. */
export const CLAUDE_AGENT_SDK_FULL_NAME = `@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`;
