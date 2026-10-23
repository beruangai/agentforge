/**
 * The secrets every agent in research-brief requires, by the environment variable each
 * becomes — beside its framework's own, ANTHROPIC_API_KEY. The agent's
 * construct requires a secret for each, `serve` passes each from
 * .env.serve.local, and the agent's server fails a request while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
