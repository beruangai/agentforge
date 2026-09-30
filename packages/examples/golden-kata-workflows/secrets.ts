/**
 * The secrets the worker requires, by the environment variable each becomes —
 * beside AgentForge's own, TEMPORAL_API_KEY. The project's construct requires
 * a secret for each, `serve` passes each from .env.serve.local (and
 * .env.hybrid.local), and the worker fails at start while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
