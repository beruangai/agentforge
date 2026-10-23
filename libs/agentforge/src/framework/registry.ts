import type { FrameworkName } from '#core/contract/framework.ts';
import type { FrameworkPlugin } from '../plugin/framework-plugin.ts';
import { plugin as claude } from './claude/plugin/index.ts';
import { plugin as strands } from './strands/plugin/index.ts';

/** Every framework this AgentForge provides, by its name in a project's record: the plugin's one way in. */
export const FRAMEWORK_PLUGINS = {
  claude,
  strands,
} as const satisfies Record<FrameworkName, FrameworkPlugin>;

/** A provided framework's plugin part. */
export function frameworkPlugin(name: FrameworkName): FrameworkPlugin {
  return FRAMEWORK_PLUGINS[name];
}
