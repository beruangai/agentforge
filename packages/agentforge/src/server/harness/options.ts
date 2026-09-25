import { merge as deepMerge } from 'ts-deepmerge';
import type { AgentOptions } from './kernel.ts';

/**
 * Composes SDK options from a house default and a procedure's own, deeply,
 * later parts winning — except where losing a contribution would be silent
 * (§REQ204). Arrays accumulate, without duplicates: hooks per event, allowed
 * and disallowed tools, and every other list. Plain objects merge key by key,
 * the environment among them. An MCP server named twice is an error rather
 * than a merge of two servers' configuration.
 */
export function composeOptions(...parts: AgentOptions[]): AgentOptions {
  const named = new Set<string>();
  for (const part of parts) {
    for (const name of Object.keys(part.mcpServers ?? {})) {
      if (named.has(name)) {
        throw new Error(`MCP server "${name}" is contributed twice`);
      }
      named.add(name);
    }
  }
  return deepMerge(...parts) as AgentOptions;
}
