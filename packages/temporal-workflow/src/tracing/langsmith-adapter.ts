/**
 * LangSmith-specific trace context extraction.
 * This is the ONLY file that imports from langsmith.
 * Swapping to Langfuse/BrainTrust means replacing this file only.
 */

type GetCurrentRunTree = () => { toHeaders(): Record<string, string> };

let getCurrentRunTree: GetCurrentRunTree | undefined;

async function ensureTraceable(): Promise<GetCurrentRunTree | undefined> {
  if (getCurrentRunTree) return getCurrentRunTree;
  try {
    const mod = await import('langsmith/traceable');
    getCurrentRunTree = mod.getCurrentRunTree as GetCurrentRunTree;
    return getCurrentRunTree;
  } catch {
    return undefined;
  }
}

/**
 * Extract LangSmith trace context as environment variables.
 * Uses getCurrentRunTree().toHeaders() for cross-process trace propagation.
 * Returns empty object if langsmith is not available or no active trace.
 */
export async function getLangSmithTraceEnv(): Promise<Record<string, string>> {
  const getRunTree = await ensureTraceable();
  if (!getRunTree) return {};

  try {
    const runTree = getRunTree();
    const headers = runTree.toHeaders();
    if (!headers || Object.keys(headers).length === 0) return {};

    // Map LangSmith headers to env vars for container injection
    const env: Record<string, string> = {};
    if (headers['langsmith-trace']) {
      env['LANGSMITH_PARENT_DOTTED_ORDER'] = headers['langsmith-trace'];
    }
    if (headers['baggage']) {
      env['LANGSMITH_PARENT_BAGGAGE'] = headers['baggage'];
    }
    return env;
  } catch {
    // No active trace context — not an error
    return {};
  }
}
