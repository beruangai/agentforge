import type { AgentOptions } from './kernel.ts';

/**
 * Composes SDK options from a house default and a procedure's own, later
 * parts winning — except where losing a contribution would be silent
 * (§REQ204): hooks, MCP servers, allowed and disallowed tools and the
 * environment accumulate, and an MCP server named twice is an error rather
 * than a replacement.
 */
export function composeOptions(...parts: AgentOptions[]): AgentOptions {
  const composed: AgentOptions = {};
  for (const part of parts) {
    const { hooks, mcpServers, allowedTools, disallowedTools, env, ...rest } =
      part;
    Object.assign(composed, rest);
    if (hooks !== undefined) {
      const merged = { ...composed.hooks };
      for (const [event, matchers] of Object.entries(hooks)) {
        const key = event as keyof typeof merged;
        merged[key] = [...(merged[key] ?? []), ...(matchers ?? [])];
      }
      composed.hooks = merged;
    }
    if (mcpServers !== undefined) {
      for (const name of Object.keys(mcpServers)) {
        if (composed.mcpServers?.[name] !== undefined) {
          throw new Error(`MCP server "${name}" is contributed twice`);
        }
      }
      composed.mcpServers = { ...composed.mcpServers, ...mcpServers };
    }
    if (allowedTools !== undefined) {
      composed.allowedTools = [
        ...new Set([...(composed.allowedTools ?? []), ...allowedTools]),
      ];
    }
    if (disallowedTools !== undefined) {
      composed.disallowedTools = [
        ...new Set([...(composed.disallowedTools ?? []), ...disallowedTools]),
      ];
    }
    if (env !== undefined) composed.env = { ...composed.env, ...env };
  }
  return composed;
}
