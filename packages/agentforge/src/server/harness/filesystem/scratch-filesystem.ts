import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Filesystem } from './filesystem.ts';

/**
 * An empty directory of the task's own, removed when the task ends: nothing
 * is pulled or pushed. Mounts under the system's temporary directory unless
 * the consumer names a path.
 */
export class ScratchFilesystem extends Filesystem {
  constructor(options: { readonly path?: string } = {}) {
    super(
      {
        ...(options.path === undefined ? {} : { path: options.path }),
        access: 'READ_WRITE',
        scope: () => ({ root: '' }),
        push: 'NEVER',
        checkpoints: false,
      },
      {
        defaultPath: ({ taskId, name }) =>
          join(tmpdir(), 'agentforge-scratch', taskId, name),
      },
    );
  }

  /** Its store is empty: there is nothing to fetch. */
  protected async pull(): Promise<void> {}

  protected push(): Promise<void> {
    throw new Error('a scratch filesystem never pushes');
  }
}
