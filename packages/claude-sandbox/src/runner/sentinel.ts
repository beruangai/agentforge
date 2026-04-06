import type { AgentForgeContainerOutput } from './types.js';

// Re-export sentinel constants from agent-runner (source of truth)
export { START_SENTINEL, END_SENTINEL } from '../agent-runner/constants.js';
import { START_SENTINEL, END_SENTINEL } from '../agent-runner/constants.js';

/**
 * Extract structured output from container stdout using sentinel markers.
 * Returns null if sentinels are missing or invalid.
 */
export function extractOutput(
  stdout: string,
): AgentForgeContainerOutput | null {
  const startIdx = stdout.indexOf(START_SENTINEL);
  const endIdx = stdout.indexOf(END_SENTINEL);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = stdout.slice(startIdx + START_SENTINEL.length, endIdx).trim();

  try {
    const parsed = JSON.parse(jsonStr) as AgentForgeContainerOutput;

    // Minimal schema validation — reject if status field is missing or invalid
    if (parsed.status !== 'success' && parsed.status !== 'error') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
