/**
 * The secrets the writer agent requires, by the environment variable each
 * becomes — beside AgentForge's own, CLAUDE_CODE_OAUTH_TOKEN. The agent's
 * construct requires a secret for each, `serve` passes each from
 * .env.serve.local, and the agent's server fails a request while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
