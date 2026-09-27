import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Filesystem } from './filesystem.ts';

/**
 * An empty directory of the task's own, removed when the task ends: nothing
 * is pulled or pushed. Mounts under the system's temporary directory unless
 * the consumer names a `localPath`.
 */
export class ScratchFilesystem extends Filesystem {
  constructor(options: { readonly localPath?: string } = {}) {
    super(
      {
        ...(options.localPath === undefined
          ? {}
          : { localPath: options.localPath }),
        scope: () => ({ remotePath: '', write: ['**'] }),
      },
      {
        defaultLocalPath: ({ taskId, name }) =>
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
