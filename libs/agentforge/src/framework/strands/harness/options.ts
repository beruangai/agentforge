import { merge as deepMerge } from 'ts-deepmerge';
import type { StrandsOptions } from './types.ts';

/**
 * Composes `strands` options from a house default and a procedure's own,
 * later parts winning — except where losing a contribution would be silent
 * (§REQ204). Lists accumulate, without duplicates: tools, plugins,
 * interventions and working directories. Plain objects merge key by key. A
 * value given as `undefined` changes nothing. An MCP server named twice is an
 * error rather than one client replacing another.
 */
export function composeOptions(
  ...parts: {
    readonly [Key in keyof StrandsOptions]?: StrandsOptions[Key] | undefined;
  }[]
): StrandsOptions {
  const named = new Set<string>();
  for (const part of parts) {
    for (const name of Object.keys(part.mcpClients ?? {})) {
      if (named.has(name)) {
        throw new Error(`MCP server "${name}" is contributed twice`);
      }
      named.add(name);
    }
  }
  return deepMerge.withOptions(
    { allowUndefinedOverrides: false },
    ...(parts as object[]),
  ) as StrandsOptions;
}
