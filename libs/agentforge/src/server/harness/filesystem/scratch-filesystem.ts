import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Filesystem } from './filesystem.ts';

/**
 * An empty directory of the task's own, removed when the task ends: nothing
 * is pulled or pushed. Its subpath is the task's id, so each task mounts its
 * own directory under the root: the consumer's `localRoot`, or one of its
 * name under the system's temporary directory.
 */
export class ScratchFilesystem extends Filesystem {
  constructor(options: { readonly localRoot?: string } = {}) {
    super(
      {
        ...(options.localRoot === undefined
          ? {}
          : { localRoot: options.localRoot }),
        scope: ({ context }) => ({ subpath: context.taskId, write: ['**'] }),
      },
      {
        defaultLocalRoot: ({ name }) =>
          join(tmpdir(), 'agentforge-scratch', name),
      },
    );
  }

  /** Its store is empty: there is nothing to fetch. */
  protected async pull(): Promise<void> {}

  protected push(): Promise<void> {
    throw new Error('a scratch filesystem never pushes');
  }
}
