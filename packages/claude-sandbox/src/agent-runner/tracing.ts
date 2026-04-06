import { RunTree } from 'langsmith';

/**
 * Reconstruct a parent RunTree from environment variables passed into the container.
 * Returns null if trace context env vars are not set.
 */
export function reconstructParentTrace(): RunTree | null {
  const dottedOrder = process.env['LANGSMITH_PARENT_DOTTED_ORDER'];
  const baggage = process.env['LANGSMITH_PARENT_BAGGAGE'];

  if (!dottedOrder) {
    return null;
  }

  const headers: Record<string, string> = {
    'langsmith-trace': dottedOrder,
  };

  if (baggage) {
    headers['baggage'] = baggage;
  }

  try {
    return (
      RunTree.fromHeaders(headers, {
        name: 'parent',
        run_type: 'chain',
      }) ?? null
    );
  } catch {
    return null;
  }
}
