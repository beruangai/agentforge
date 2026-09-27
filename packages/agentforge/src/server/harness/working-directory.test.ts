import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oc } from '@orpc/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contractHash } from '#core/contract/procedures.ts';
import { executeProcedure, implementAgent } from './task-process.ts';
import {
  declaredWorkingDirectories,
  type S7cmdResult,
  TaskWorkingDirectories,
  type WorkingDirectorySync,
} from './working-directory.ts';

/** A scripted `s7cmd`: records every call, and answers each with the next result, or success. */
function scriptedS7cmd(...results: S7cmdResult[]) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<S7cmdResult> => {
    calls.push([...args]);
    return results.shift() ?? { exitCode: 0, stderr: '' };
  };
  return { run, calls };
}

const SYNC: WorkingDirectorySync = {
  pull: true,
  push: 'WHEN_COMPLETED',
  continuous: false,
  deletes: true,
  exclude: ['\\.tmp$'],
};
const EXCLUDE = '(?:(^|/)\\.\\.(/|$))|(?:\\.tmp$)';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentforge-working-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function directories(s7cmd: ReturnType<typeof scriptedS7cmd>, taskId = 't-1') {
  return new TaskWorkingDirectories({
    taskId,
    buckets: { vault: 'vault-bucket' },
    s7cmd: s7cmd.run,
    root,
  });
}

describe('TaskWorkingDirectories', () => {
  it('pulls its prefix, and pushes it back by ETag, deleting what the task removed, never what it excludes', async () => {
    const s7cmd = scriptedS7cmd();
    const task = directories(s7cmd);
    const { path } = await task.open({
      name: 'vault',
      prefix: 'entities/acme/',
      sync: SYNC,
    });
    expect(path).toBe(join(root, 't-1', 'vault'));
    await task.close('COMPLETED');
    expect(s7cmd.calls).toEqual([
      [
        'sync',
        '--filter-exclude-regex',
        EXCLUDE,
        's3://vault-bucket/entities/acme/',
        `${path}/`,
      ],
      [
        'sync',
        '--filter-exclude-regex',
        EXCLUDE,
        '--check-etag',
        '--delete',
        `${path}/`,
        's3://vault-bucket/entities/acme/',
      ],
    ]);
  });

  it('pushes as its sync says, and never after a cancel', async () => {
    const cases = [
      ['WHEN_COMPLETED', 'COMPLETED', true],
      ['WHEN_COMPLETED', 'FAILED', false],
      ['WHEN_ENDED', 'FAILED', true],
      ['WHEN_ENDED', 'CANCELED', false],
      ['NEVER', 'COMPLETED', false],
    ] as const;
    for (const [push, ending, pushed] of cases) {
      const s7cmd = scriptedS7cmd();
      const task = directories(s7cmd, `${push}-${ending}`);
      await task.open({
        name: 'vault',
        prefix: 'p',
        sync: { ...SYNC, pull: false, deletes: false, push },
      });
      await task.close(ending);
      expect([push, ending, s7cmd.calls.length]).toEqual([
        push,
        ending,
        pushed ? 1 : 0,
      ]);
    }
  });

  it('pushes continuously, leaving what changed in the quiet period', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const s7cmd = scriptedS7cmd();
    const task = directories(s7cmd);
    await task.open({
      name: 'vault',
      prefix: 'p',
      sync: {
        ...SYNC,
        pull: false,
        deletes: false,
        push: 'WHEN_ENDED',
        continuous: { everySeconds: 5, quietSeconds: 30 },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    // A cancel pushes nothing more, but waits for the push under way.
    await task.close('CANCELED');
    expect(s7cmd.calls).toHaveLength(1);
    expect(s7cmd.calls[0]).toEqual(
      expect.arrayContaining([
        '--filter-mtime-before',
        '2026-09-26T23:59:35.000Z',
      ]),
    );
  });

  it('fails unsynced on any exit but 0, carrying what s7cmd said', async () => {
    const task = directories(
      scriptedS7cmd(
        { exitCode: 0, stderr: '' },
        { exitCode: 3, stderr: 'ETag mismatch: out.md' },
      ),
    );
    await task.open({ name: 'vault', prefix: 'p', sync: SYNC });
    await expect(task.close('COMPLETED')).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        retryable: true,
        message: expect.stringContaining('s7cmd exited 3: ETag mismatch'),
      },
    });

    await expect(
      directories(
        scriptedS7cmd({ exitCode: 1, stderr: 'AccessDenied' }),
        't-2',
      ).open({ name: 'vault', prefix: 'p', sync: SYNC }),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        message: expect.stringContaining('could not be pulled'),
      },
    });
  });

  it('fails a pattern s7cmd refuses as the procedure’s error, not the store’s', async () => {
    const pulled = directories(
      scriptedS7cmd({ exitCode: 2, stderr: 'invalid regex' }),
    ).open({ name: 'vault', prefix: 'p', sync: { ...SYNC, exclude: ['('] } });
    await expect(pulled).rejects.toThrow(/check its `exclude` patterns/);
    await expect(pulled).rejects.not.toHaveProperty('taskCause');
  });

  it('refuses what it cannot honour, before anything is pulled', async () => {
    const s7cmd = scriptedS7cmd();
    const task = directories(s7cmd);
    const refused = [
      [{ name: 'nope', prefix: 'p', sync: SYNC }, /"nope".*declared: vault/],
      [{ name: 'vault', prefix: 'a/../b', sync: SYNC }, /never climbs/],
      [
        {
          name: 'vault',
          prefix: 'p',
          sync: { ...SYNC, continuous: { everySeconds: 30, quietSeconds: 5 } },
        },
        /WHEN_ENDED/,
      ],
      [
        { name: 'vault', prefix: 'p', sync: { ...SYNC, pull: false } },
        /deletes needs `pull`/,
      ],
      [{ name: 'vault', prefix: '/', sync: SYNC }, /never climbs/],
      [{ name: 'vault', prefix: '', sync: SYNC }, /deletes needs a prefix/],
    ] as const;
    for (const [spec, message] of refused) {
      await expect(task.open(spec)).rejects.toThrow(message);
    }
    expect(s7cmd.calls).toEqual([]);
    await task.open({ name: 'vault', prefix: 'p', sync: SYNC });
    await expect(
      task.open({ name: 'vault', prefix: 'q', sync: SYNC }),
    ).rejects.toThrow(/already open/);
  });
});

describe('declaredWorkingDirectories', () => {
  it('reads the buckets the construct declared, and none locally', () => {
    expect(declaredWorkingDirectories({})).toEqual({});
    expect(
      declaredWorkingDirectories({
        AGENTFORGE_WORKING_DIRECTORIES: '{"vault":"vault-bucket"}',
      }),
    ).toEqual({ vault: 'vault-bucket' });
  });
});

describe('executeProcedure, with a working directory', () => {
  const contract = {
    write: oc.input(z.object({})).output(z.object({ ok: z.boolean() })),
  };
  const os = implementAgent(contract);
  const router = os.router({
    write: os.write.handler(async ({ context }) => {
      const { path } = await context.openWorkingDirectory({
        name: 'vault',
        prefix: 'out',
        sync: SYNC,
      });
      await writeFile(join(path, 'result.md'), 'done');
      return { ok: true };
    }),
  });

  function execute(s7cmd: ReturnType<typeof scriptedS7cmd>) {
    return executeProcedure({
      contract,
      router,
      invocation: {
        taskId: 't-1',
        contextId: 'c-1',
        runtimeSessionId: 'r-1',
        attempt: 1,
        priorAttempt: undefined,
        envelope: {
          procedure: 'write',
          contractHash: contractHash(contract.write),
          input: {},
          idempotencyKey: 'k-1',
        },
      },
      signal: new AbortController().signal,
      onRecord: () => undefined,
      workingDirectories: {
        buckets: { vault: 'vault-bucket' },
        s7cmd: s7cmd.run,
        root,
      },
    });
  }

  it('publishes the outcome after the push, and removes its local copy', async () => {
    const s7cmd = scriptedS7cmd();
    expect(await execute(s7cmd)).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { ok: true },
    });
    expect(s7cmd.calls.map((call) => call.at(-1))).toEqual([
      `${join(root, 't-1', 'vault')}/`,
      's3://vault-bucket/out/',
    ]);
    expect(existsSync(join(root, 't-1'))).toBe(false);
  });

  it('fails a completed task whose push failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await execute(
        scriptedS7cmd(
          { exitCode: 0, stderr: '' },
          { exitCode: 1, stderr: 'SlowDown' },
        ),
      ),
    ).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'WORKING_DIRECTORY_UNSYNCED' },
    });
  });
});
