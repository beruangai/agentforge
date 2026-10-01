import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oc } from '@orpc/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractHash } from '#core/contract/procedures.ts';
import { cause } from '#core/contract/task.ts';
import { TaskFailure } from '../kernel.ts';
import { executeProcedure, implementAgent } from '../task-process.ts';
import { ScriptedFilesystem } from './__fixtures__/scripted-filesystem.ts';
import { FilesystemUnsynced } from './filesystem.ts';
import { filesystems } from './registry.ts';

const Mounted = z.object({
  names: z.array(z.string()),
  pulled: z.boolean(),
  allow: z.array(z.string()),
});
const contract = {
  added: oc.input(z.object({ fail: z.boolean() })).output(Mounted),
  alone: oc.input(z.object({ fail: z.boolean() })).output(Mounted),
};

let root: string;
let house: ScriptedFilesystem;
let scratch: ScriptedFilesystem;
let workspace: ScriptedFilesystem;
let notes: ScriptedFilesystem;
let ran: boolean;

function build() {
  const os = implementAgent(contract).use(
    filesystems({ workspace: house, scratch }),
  );
  return os.router({
    added: os.added
      .use(filesystems({ workspace, notes }))
      .handler(async ({ input, context }) => {
        ran = true;
        if (input.fail) {
          throw new TaskFailure(cause('EXECUTION_ERROR', 'the handler failed'));
        }
        return {
          names: Object.keys(context.filesystems).sort(),
          pulled: existsSync(
            join(context.filesystems.workspace?.localPath ?? '', 'pulled.md'),
          ),
          allow: [...context.filesystemPermissions.allow],
        };
      }),
    alone: os.alone
      .use(filesystems({ notes }, { replaceUpstream: true }))
      .handler(async ({ context }) => ({
        names: Object.keys(context.filesystems),
        pulled: false,
        allow: [],
      })),
  });
}

function execute(procedure: keyof typeof contract, fail = false) {
  return executeProcedure({
    contract,
    router: build(),
    invocation: {
      taskId: 't-1',
      contextId: 'c-1',
      runtimeSessionId: 'r-1',
      attempt: 1,
      priorAttempt: undefined,
      envelope: {
        procedure,
        contractHash: contractHash(contract[procedure]),
        input: { fail },
        idempotencyKey: 'k-1',
      },
    },
    signal: new AbortController().signal,
    onRecord: () => undefined,
  });
}

/** A filesystem that pushes on success, mounted at `name` under the test's root. */
const at = (name: string) =>
  ({ localRoot: join(root, name), pushOn: ['TASK_STATE_COMPLETED'] }) as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentforge-registry-'));
  house = new ScriptedFilesystem(at('house'));
  scratch = new ScriptedFilesystem(at('scratch'));
  workspace = new ScriptedFilesystem(at('workspace'));
  notes = new ScriptedFilesystem(at('notes'));
  ran = false;
});

describe('filesystems registered on a procedure', () => {
  it('append to those upstream, a name registered again replaced, and are mounted before the handler', async () => {
    const outcome = await execute('added');
    expect(outcome).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: {
        names: ['notes', 'scratch', 'workspace'],
        pulled: true,
        allow: [
          `Read(/${root}/workspace/**)`,
          `Edit(/${root}/workspace/**)`,
          `Read(/${root}/scratch/**)`,
          `Edit(/${root}/scratch/**)`,
          `Read(/${root}/notes/**)`,
          `Edit(/${root}/notes/**)`,
        ],
      },
    });
    expect(house.calls).toEqual([]);
    expect(workspace.calls).toEqual(['pull /', 'push /']);
    for (const name of ['workspace', 'scratch', 'notes']) {
      expect(existsSync(join(root, name))).toBe(false);
    }
  });

  it('drop those upstream when they replace them', async () => {
    expect(await execute('alone')).toMatchObject({
      output: { names: ['notes'] },
    });
    expect(scratch.calls).toEqual([]);
    expect(notes.calls).toEqual(['pull /', 'push /']);
  });

  it('fail a completed task whose push fails, unsynced', async () => {
    workspace = new ScriptedFilesystem(at('workspace'), {
      push: () => Promise.reject(new FilesystemUnsynced('refused')),
    });
    expect(await execute('added')).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: 'filesystem "workspace" could not be pushed: refused',
        retryable: true,
      },
    });
  });

  it('keep a failed task’s cause, the push’s failure added to it', async () => {
    workspace = new ScriptedFilesystem(
      {
        ...at('workspace'),
        pushOn: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
      },
      { push: () => Promise.reject(new FilesystemUnsynced('refused')) },
    );
    expect(await execute('added', true)).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'EXECUTION_ERROR',
        message:
          'the handler failed; and filesystem "workspace" could not be pushed: refused',
      },
    });
  });

  it('fail the task before anything mounts when two share a directory, or one is inside another', async () => {
    notes = new ScriptedFilesystem(at('workspace/notes'));
    expect(await execute('added')).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'EXECUTION_ERROR',
        message: expect.stringMatching(
          /filesystems "workspace" .+ and "notes" .+ mount at the same directory or one inside the other/,
        ),
      },
    });
    expect(ran).toBe(false);
    expect([...workspace.calls, ...scratch.calls, ...notes.calls]).toEqual([]);
  });

  it('fail the task before the handler when one cannot mount, unmounting those that did', async () => {
    workspace = new ScriptedFilesystem(at('workspace'), {
      pull: () => Promise.reject(new FilesystemUnsynced('refused')),
    });
    expect(await execute('added')).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'FILESYSTEM_UNSYNCED' },
    });
    expect(ran).toBe(false);
    expect(existsSync(join(root, 'scratch'))).toBe(false);
  });
});
