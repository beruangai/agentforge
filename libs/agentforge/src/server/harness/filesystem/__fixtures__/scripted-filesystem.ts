import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Filesystem,
  type FilesystemOptions,
  type Mount,
} from '../filesystem.ts';

/** What a scripted operation does after it is recorded: resolve, or throw. */
interface Script {
  readonly pull?: () => Promise<void>;
  readonly push?: () => Promise<void>;
}

/**
 * A kind whose operations are recorded, and fail as scripted: `pull` leaves
 * `pulled.md` in the mount.
 */
export class ScriptedFilesystem extends Filesystem {
  readonly calls: string[] = [];
  readonly #script: Script;

  constructor(options: Partial<FilesystemOptions>, script: Script = {}) {
    super({
      scope: () => ({ subpath: '' }),
      ...options,
    });
    this.#script = script;
  }

  protected async pull(mount: Mount): Promise<void> {
    this.calls.push(`pull ${mount.remotePath}`);
    await writeFile(join(mount.localPath, 'pulled.md'), 'pulled');
    await this.#script.pull?.();
  }

  protected async push(
    mount: Mount,
    options: { readonly modifiedBefore?: Date },
  ): Promise<void> {
    this.calls.push(
      options.modifiedBefore === undefined
        ? `push ${mount.remotePath}`
        : `checkpoint ${options.modifiedBefore.toISOString()}`,
    );
    await this.#script.push?.();
  }
}
