import { minimatch } from 'minimatch';
import type { GatewayTool } from './types.js';

const HEADER_NAME = 'x-tools';

/**
 * Filter tools to only those matching the requested patterns.
 * Patterns support glob syntax via minimatch (e.g., `vault:*`).
 */
export function filterTools(
  allTools: GatewayTool[],
  requestedPatterns: string[],
): GatewayTool[] {
  return allTools.filter((tool) =>
    requestedPatterns.some((pattern) => minimatch(tool.name, pattern)),
  );
}

/**
 * Check if a single tool name is allowed by the given filter patterns.
 */
export function isToolAllowed(
  toolName: string,
  requestedPatterns: string[],
): boolean {
  return requestedPatterns.some((pattern) => minimatch(toolName, pattern));
}

/**
 * Parse the `X-Tools` header from a request into filter patterns.
 * Returns `['*']` if the header is absent (all tools allowed).
 */
export function parseToolFilter(headers: Headers): string[] {
  const header = headers.get(HEADER_NAME);
  if (!header) return ['*'];
  const patterns = header
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return patterns.length > 0 ? patterns : ['*'];
}
