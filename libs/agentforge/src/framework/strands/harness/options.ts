import type {
  HookableEvent,
  HookableEventConstructor,
  HookCallback,
  HookCallbackOptions,
} from '@strands-agents/sdk';
import { merge as deepMerge } from 'ts-deepmerge';
import type { StrandsHook, StrandsOptions } from './types.ts';

/**
 * A callback on one of the agent's events, for `StrandsOptions.hooks`: the
 * arguments `agent.addHook` takes, its callback typed by its event.
 */
export function hook<Event extends HookableEvent>(
  event: HookableEventConstructor<Event>,
  callback: HookCallback<Event>,
  options?: HookCallbackOptions,
): StrandsHook {
  return {
    event,
    callback: callback as HookCallback<HookableEvent>,
    ...(options === undefined ? {} : { options }),
  };
}

/**
 * Composes `strands` options from a house default and a procedure's own,
 * later parts winning — except where losing a contribution would be silent
 * (§REQ204). Lists accumulate, without duplicates: tools, plugins, hooks,
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
