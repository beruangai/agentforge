import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Filesystem,
  type FilesystemOptions,
  type Mount,
  type PushReport,
} from '../filesystem.ts';

/** What a scripted operation does after it is recorded: resolve, or throw. */
interface Script {
  readonly pull?: () => Promise<void>;
  readonly push?: () => Promise<void>;
  /** Offers the agent a push, which records its message. */
  readonly agentPush?: () => Promise<void>;
  /** The store a kept copy is identified by; `scripted` unless given. */
  readonly store?: string;
  readonly deletes?: boolean;
  readonly localOnly?: boolean;
  readonly shapesPushMessage?: boolean;
}

/**
 * A kind whose operations are recorded, and fail as scripted: `pull` leaves
 * `pulled.md` in the mount.
 */
export class ScriptedFilesystem<in Input = unknown> extends Filesystem<Input> {
  readonly calls: string[] = [];
  readonly #script: Script;

  constructor(options: Partial<FilesystemOptions<Input>>, script: Script = {}) {
    super(
      {
        scope: () => ({ subpath: '' }),
        ...options,
      },
      {
        deletes: script.deletes === true,
        localOnly: script.localOnly === true,
        shapesPushMessage: script.shapesPushMessage === true,
      },
    );
    this.#script = script;
    if (script.agentPush !== undefined) {
      const agentPush = script.agentPush;
      this.agentPush = async (_mount: Mount, message: string) => {
        this.calls.push(`agent push ${message}`);
        await agentPush();
        return { files: [] } satisfies PushReport;
      };
    }
  }

  protected override agentPush?: (
    mount: Mount,
    message: string,
  ) => Promise<PushReport>;

  protected storeIdentity(): string {
    return this.#script.store ?? 'scripted';
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
