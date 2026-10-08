import { join } from 'node:path';

/** The repository root: the `agentforge` marketplace. */
export const REPOSITORY_ROOT = join(import.meta.dirname, '../../../../../..');

/** The `agentforge` plugin, at the marketplace's `./claude-plugin`. */
export const PLUGIN_DIRECTORY = join(REPOSITORY_ROOT, 'claude-plugin');
