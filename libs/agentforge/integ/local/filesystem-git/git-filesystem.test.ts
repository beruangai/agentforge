/**
 * AgentForge's composition of git, against real git and bare `file://`
 * repositories: a subtree mounted without a checkout, a push of the write
 * scope merged onto a moved branch in memory, a file both writers changed
 * refused, deletes relative to the base, a kept copy, the agent's push, and
 * the token kept from the environment (ADR 0024).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitFilesystem,
  type GitFilesystemOptions,
} from '../../../src/server/harness/filesystem/git-filesystem.ts';
import type {
  FrameworkTypes,
  TaskContext,
} from '../../../src/server/harness/framework.ts';

const IDENTITY = [
  '-c',
  'user.name=Other',
  '-c',
  'user.email=other@example.com',
];

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

let root: string;
let bare: string;
/** Another writer's working clone of the repository. */
let other: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentforge-git-integ-'));
  bare = join(root, 'vault.git');
  other = join(root, 'other');
  git(['init', '--quiet', '--bare', '--initial-branch=main', bare], root);
  git(['config', 'uploadpack.allowFilter', 'true'], bare);
  git(['clone', '--quiet', bare, other], root);
  git(['checkout', '--quiet', '-B', 'main'], other);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The other writer commits these files (null deletes one) and pushes. */
function otherPushes(
  files: Record<string, string | null>,
  message = 'other',
): string {
  git(['fetch', '--quiet', 'origin'], other);
  if (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
      cwd: other,
    }).status === 0
  ) {
    git(['reset', '--quiet', '--hard', 'origin/main'], other);
  }
  for (const [path, content] of Object.entries(files)) {
    const file = join(other, path);
    if (content === null) {
      git(['rm', '--quiet', path], other);
    } else {
      execFileSync('mkdir', ['-p', dirname(file)]);
      writeFileSync(file, content);
      git(['add', path], other);
    }
  }
  git(['commit', '--quiet', '-m', message], other);
  git(['push', '--quiet', 'origin', 'main'], other);
  return git(['rev-parse', 'HEAD'], other);
}

function onBranch(path: string): string | undefined {
  const result = spawnSync('git', ['show', `main:${path}`], {
    cwd: bare,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout : undefined;
}

function filesystem(
  options: Partial<GitFilesystemOptions> = {},
  environment: NodeJS.ProcessEnv = {},
): GitFilesystem {
  return new GitFilesystem(
    {
      localRoot: join(root, 'mounts', 'vault'),
      repository: 'vault',
      pushOn: ['TASK_STATE_COMPLETED'],
      scope: () => ({ subpath: '' }),
      ...options,
    },
    {
      environment: {
        AGENTFORGE_FILESYSTEM_REPOSITORIES: JSON.stringify({
          vault: `file://${bare}`,
        }),
        AGENTFORGE_AGENT_NAME: 'tester',
        ...environment,
      },
    },
  );
}

function mount(
  target: GitFilesystem,
  { runtimeSessionId = 'r-1', taskId = randomUUIDv7() } = {},
) {
  return target.mount(
    target.resolve({
      name: 'vault',
      taskId,
      request: {
        input: {},
        context: {
          taskId,
          runtimeSessionId,
          idempotencyKey: 'key-1',
          attempt: 1,
        } as TaskContext<FrameworkTypes>,
      },
    }),
  );
}

describe('GitFilesystem', () => {
  it('mounts a subtree of the branch as its root, and nothing outside it', async () => {
    otherPushes({
      'projects/alpha/plan.md': 'plan',
      'projects/beta/other.md': 'beta',
      'README.md': 'readme',
    });
    const vault = await mount(
      filesystem({
        remoteRoot: '/projects',
        scope: () => ({ subpath: 'alpha' }),
      }),
    );
    const { localPath } = vault.mounted;
    expect(readFileSync(join(localPath, 'plan.md'), 'utf8')).toBe('plan');
    expect(existsSync(join(localPath, 'other.md'))).toBe(false);
    expect(existsSync(join(localPath, 'README.md'))).toBe(false);
    await vault.unmount('TASK_STATE_COMPLETED');
  });

  it('mounts an empty branch empty, and its first push is a root commit', async () => {
    const vault = await mount(filesystem({ remoteRoot: '/notes' }));
    await writeFile(join(vault.mounted.localPath, 'first.md'), 'first');
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('notes/first.md')).toBe('first');
    expect(git(['rev-list', '--count', 'main'], bare)).toBe('1');
  });

  it('commits the write scope only, with its message, author and trailers', async () => {
    otherPushes({ 'index.md': 'index', 'notes/today.md': 'old' });
    const vault = await mount(
      filesystem({
        scope: () => ({ subpath: '', write: ['notes/**'] }),
        message: () => 'record today',
      }),
    );
    const { localPath } = vault.mounted;
    await writeFile(join(localPath, 'notes', 'today.md'), 'new');
    await writeFile(join(localPath, 'index.md'), 'changed locally');
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('notes/today.md')).toBe('new');
    expect(onBranch('index.md')).toBe('index');
    const log = git(['log', '-1', '--format=%an <%ae>%n%B', 'main'], bare);
    expect(log).toContain('tester <tester@agentforge.invalid>');
    expect(log).toContain('record today');
    expect(log).toMatch(/AgentForge-Task-Id: \S+/);
    expect(log).toContain('AgentForge-Idempotency-Key: key-1');
    expect(log).toContain('AgentForge-Attempt: 1');
  });

  it('adds no commit when the write scope has no change', async () => {
    const before = otherPushes({ 'a.md': 'a' });
    const vault = await mount(filesystem());
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(git(['rev-parse', 'main'], bare)).toBe(before);
  });

  it("merges onto another writer's push to a different file", async () => {
    otherPushes({ 'alpha/plan.md': 'plan', 'beta/notes.md': 'notes' });
    const vault = await mount(filesystem({ remoteRoot: '/alpha' }));
    await writeFile(join(vault.mounted.localPath, 'plan.md'), 'ours');
    const theirs = otherPushes({ 'beta/notes.md': 'theirs' });
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('alpha/plan.md')).toBe('ours');
    expect(onBranch('beta/notes.md')).toBe('theirs');
    expect(git(['rev-parse', 'main^'], bare)).toBe(theirs);
  });

  it('refuses a push when another writer changed the same file, keeping theirs', async () => {
    otherPushes({ 'alpha/plan.md': 'plan' });
    const vault = await mount(filesystem({ remoteRoot: '/alpha' }));
    await writeFile(join(vault.mounted.localPath, 'plan.md'), 'ours');
    otherPushes({ 'alpha/plan.md': 'theirs' });
    await expect(vault.unmount('TASK_STATE_COMPLETED')).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: expect.stringContaining('plan.md'),
      },
    });
    expect(onBranch('alpha/plan.md')).toBe('theirs');
  });

  it('records a deletion only when deletes are enabled, never deleting what another writer added', async () => {
    otherPushes({ 'alpha/draft.md': 'draft', 'alpha/keep.md': 'keep' });
    const off = await mount(filesystem({ remoteRoot: '/alpha' }));
    await unlink(join(off.mounted.localPath, 'draft.md'));
    await off.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('alpha/draft.md')).toBe('draft');

    const on = await mount(
      filesystem({
        localRoot: join(root, 'mounts', 'deleting'),
        remoteRoot: '/alpha',
        dangerouslyEnableDeletes: true,
      }),
    );
    expect(on.mounted.permissions).toContainEqual({
      action: 'delete',
      glob: '**',
    });
    await unlink(join(on.mounted.localPath, 'draft.md'));
    otherPushes({ 'alpha/new.md': 'new' });
    await on.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('alpha/draft.md')).toBeUndefined();
    expect(onBranch('alpha/new.md')).toBe('new');
    expect(onBranch('alpha/keep.md')).toBe('keep');
  });

  it('keeps a copy for the next task of the session, and never for another session', async () => {
    otherPushes({ 'plan.md': 'plan', 'shared.md': 'base' });
    const target = filesystem({
      scope: () => ({ subpath: '', write: ['plan.md'] }),
    });
    const first = await mount(target);
    const { localPath } = first.mounted;
    await writeFile(join(localPath, 'scratch.md'), 'mine');
    await writeFile(join(localPath, 'shared.md'), 'local');
    await first.unmount('TASK_STATE_COMPLETED');
    otherPushes({ 'shared.md': 'theirs', 'plan.md': 'moved' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await mount(target);
    expect(readFileSync(join(localPath, 'scratch.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(localPath, 'shared.md'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(localPath, 'plan.md'), 'utf8')).toBe('moved');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared.md'));
    warn.mockRestore();
    await second.unmount('TASK_STATE_COMPLETED');

    const elsewhere = await mount(target, { runtimeSessionId: 'r-2' });
    expect(existsSync(join(localPath, 'scratch.md'))).toBe(false);
    expect(readFileSync(join(localPath, 'plan.md'), 'utf8')).toBe('moved');
    await elsewhere.unmount('TASK_STATE_COMPLETED');
  });

  it('restores a file deleted locally when the branch did not move', async () => {
    otherPushes({ 'plan.md': 'plan' });
    const target = filesystem({ pushOn: ['TASK_STATE_FAILED'] });
    const first = await mount(target);
    await unlink(join(first.mounted.localPath, 'plan.md'));
    await first.unmount('TASK_STATE_COMPLETED');
    const second = await mount(target);
    expect(
      readFileSync(join(second.mounted.localPath, 'plan.md'), 'utf8'),
    ).toBe('plan');
    await second.unmount('TASK_STATE_COMPLETED');
  });

  it("offers the agent a push mid-task, with the agent's message", async () => {
    const vault = await mount(filesystem({ pushOn: ['TASK_STATE_FAILED'] }));
    const { localPath, push } = vault.mounted;
    expect(push).toBeDefined();
    await mkdir(join(localPath, 'notes'), { recursive: true });
    await writeFile(join(localPath, 'notes', 'partial.md'), 'partial');
    const report = await push?.('partial work');
    expect(report?.files).toEqual(['notes/partial.md']);
    expect(git(['log', '-1', '--format=%s', 'main'], bare)).toBe(
      'partial work',
    );
    expect(report?.commit).toBe(git(['rev-parse', 'main'], bare));
    await expect(push?.('nothing more')).resolves.toEqual({ files: [] });
    await vault.unmount('TASK_STATE_COMPLETED');
  });

  it('removes the token from the environment a node:child_process child inherits, and keeps it out of a cause', async () => {
    const environment: NodeJS.ProcessEnv = {
      AGENTFORGE_FILESYSTEM_REPOSITORIES: JSON.stringify({
        vault: 'https://127.0.0.1:9/o/vault.git',
      }),
      AGENTFORGE_AGENT_NAME: 'tester',
      VAULT_GIT_TOKEN: 'token-for-the-integ',
    };
    const previous = process.env.VAULT_GIT_TOKEN;
    process.env.VAULT_GIT_TOKEN = 'token-for-the-integ';
    try {
      new GitFilesystem({
        localRoot: join(root, 'mounts', 'process'),
        repository: 'vault',
        tokenVariable: 'VAULT_GIT_TOKEN',
        scope: () => ({ subpath: '' }),
      });
      const child = spawnSync('env', { encoding: 'utf8' });
      expect(child.stdout).not.toContain('token-for-the-integ');
    } finally {
      if (previous === undefined) delete process.env.VAULT_GIT_TOKEN;
      else process.env.VAULT_GIT_TOKEN = previous;
    }

    const remote = new GitFilesystem(
      {
        localRoot: join(root, 'mounts', 'remote'),
        repository: 'vault',
        tokenVariable: 'VAULT_GIT_TOKEN',
        scope: () => ({ subpath: '' }),
      },
      { environment },
    );
    expect(environment.VAULT_GIT_TOKEN).toBeUndefined();
    const failure = await mount(remote).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('token-for-the-integ');
    expect(failure).toMatchObject({
      taskCause: { code: 'FILESYSTEM_UNSYNCED' },
    });
  });

  it('needs no token for a repository on disk', async () => {
    otherPushes({ 'a.md': 'a' });
    const vault = await mount(filesystem({ tokenVariable: 'UNSET_GIT_TOKEN' }));
    await writeFile(join(vault.mounted.localPath, 'b.md'), 'b');
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(onBranch('b.md')).toBe('b');
  });
});
