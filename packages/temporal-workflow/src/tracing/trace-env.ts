import { getLangSmithTraceEnv } from './langsmith-adapter.js';

/**
 * Extract current trace context as environment variables for container propagation.
 * Delegates to the configured adapter (default: LangSmith RunTree headers).
 * Returns empty object if no trace context is active.
 */
export async function getTraceEnvVars(): Promise<Record<string, string>> {
  return getLangSmithTraceEnv();
}
