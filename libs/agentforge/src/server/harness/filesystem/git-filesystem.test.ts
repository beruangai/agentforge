import { describe, expect, it } from 'vitest';
import type { FrameworkTypes, TaskContext } from '../framework.ts';
import {
  backoffMilliseconds,
  GitFilesystem,
  type GitFilesystemOptions,
  type GitRunner,
  isContended,
  isCredentialRefusal,
  redactor,
  selectChanges,
} from './git-filesystem.ts';
import type { ChildResult } from './run-child.ts';

const NO_GIT: GitRunner = () => {
  throw new Error('validation runs no git');
};

function declared(
  repositories: Record<string, string>,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    AGENTFORGE_FILESYSTEM_REPOSITORIES: JSON.stringify(repositories),
    AGENTFORGE_AGENT_NAME: 'tester',
    ...extra,
  };
}

function construct(
  options: Partial<GitFilesystemOptions> & Record<string, unknown> = {},
  environment: NodeJS.ProcessEnv = declared({ vault: 'file:///srv/vault' }),
): GitFilesystem {
  return new GitFilesystem(
    {
      localRoot: '/workspace/vault',
      repository: 'vault',
      scope: () => ({ subpath: '' }),
      ...options,
    } as GitFilesystemOptions,
    { git: NO_GIT, environment },
  );
}

function mountOf(filesystem: GitFilesystem, remoteRoot?: string) {
  return filesystem.mount({
    ...filesystem.resolve({
      name: 'vault',
      taskId: 't-1',
      request: {
        input: {},
        context: { runtimeSessionId: 'r-1' } as TaskContext<FrameworkTypes>,
      },
    }),
    ...(remoteRoot === undefined ? {} : { remotePath: remoteRoot }),
  });
}

describe('GitFilesystem options', () => {
  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'checkpoints',
      { checkpoints: { intervalSeconds: 30, settleSeconds: 5 } },
      /has no checkpoints/,
    ],
    [
      'an invalid branch',
      { branch: 'feature..x' },
      /branch "feature\.\.x" is not a valid branch name/,
    ],
    [
      'a branch starting with a dash',
      { branch: '-main' },
      /not a valid branch name/,
    ],
    [
      'a repository name it could not mount by',
      { repository: 'Vault' },
      /repository "Vault" must match/,
    ],
    [
      'a token variable that is no variable name',
      { tokenVariable: 'vault-token' },
      /tokenVariable "vault-token"/,
    ],
  ])('refuses %s when declared', (_label, options, message) => {
    expect(() => construct(options)).toThrow(message);
  });

  it('takes the token out of the environment it was given', () => {
    const environment = declared(
      { vault: 'https://github.com/o/vault.git' },
      { VAULT_TOKEN: 'secret' },
    );
    construct({ tokenVariable: 'VAULT_TOKEN' }, environment);
    expect(environment.VAULT_TOKEN).toBeUndefined();
  });

  it.each<[string, Partial<GitFilesystemOptions>, NodeJS.ProcessEnv, RegExp]>([
    [
      'an undeclared repository',
      {},
      declared({ notes: 'file:///srv/notes' }),
      /no repository "vault" is declared to this agent; declared: notes/,
    ],
    [
      'an unsupported scheme',
      {},
      declared({ vault: 'ssh://git@github.com/o/vault' }),
      /must be https:\/\/ or file:\/\/, not ssh:/,
    ],
    [
      'a credential in the URL',
      {},
      declared({ vault: 'https://x:y@github.com/o/vault' }),
      /carries a credential in its URL/,
    ],
    [
      'https without a token variable',
      {},
      declared({ vault: 'https://github.com/o/vault' }),
      /needs a tokenVariable/,
    ],
    [
      'https with its token unset',
      { tokenVariable: 'UNSET_TOKEN' },
      declared({ vault: 'https://github.com/o/vault' }),
      /UNSET_TOKEN is not set/,
    ],
    [
      'no author',
      {},
      {
        AGENTFORGE_FILESYSTEM_REPOSITORIES: JSON.stringify({
          vault: 'file:///srv/vault',
        }),
      },
      /needs an author/,
    ],
  ])(
    'refuses %s before anything is mounted',
    async (_label, options, environment, message) => {
      await expect(mountOf(construct(options, environment))).rejects.toThrow(
        message,
      );
    },
  );

  it('refuses deletes on the whole repository', async () => {
    await expect(
      mountOf(
        construct({
          dangerouslyEnableDeletes: true,
          pushOn: ['TASK_STATE_COMPLETED'],
        }),
      ),
    ).rejects.toThrow(
      /dangerouslyEnableDeletes needs a remote root or subpath/,
    );
  });
});

describe('selectChanges', () => {
  const changes = {
    changed: ['notes/today.md', 'index.md', 'notes/draft.tmp'],
    deleted: ['notes/old.md', 'outside.md'],
  };

  it('keeps the write scope less what is excluded, and deletions only when deleting', () => {
    const scope = { write: ['notes/**'], exclude: ['**/*.tmp'] };
    expect(selectChanges(changes, { ...scope, deletes: false })).toEqual({
      changed: ['notes/today.md'],
      deleted: [],
    });
    expect(selectChanges(changes, { ...scope, deletes: true })).toEqual({
      changed: ['notes/today.md'],
      deleted: ['notes/old.md'],
    });
  });
});

describe('redactor', () => {
  it('replaces every secret it holds, and nothing else', () => {
    const redact = redactor(['s3cret', 'czNjcmV0', '']);
    expect(redact('fatal: s3cret and czNjcmV0, s3cret again')).toBe(
      'fatal: *** and ***, *** again',
    );
  });
});

describe('classification', () => {
  const result = (stderr: string, timedOut = false): ChildResult => ({
    exitCode: 1,
    stdout: '',
    stderr,
    timedOut,
  });

  it.each([
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/v.git/'",
    'fatal: unable to access: The requested URL returned error: 403',
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ])('a refused credential: %s', (stderr) => {
    expect(isCredentialRefusal(stderr)).toBe(true);
  });

  it('a missing repository is not a refused credential', () => {
    expect(isCredentialRefusal("fatal: repository 'x' not found")).toBe(false);
  });

  it.each([
    ' ! [rejected]        abc -> main (fetch first)',
    ' ! [remote rejected] abc -> main (failed to update ref)',
    "error: cannot lock ref 'refs/heads/main': Unable to create '/r/refs/heads/main.lock': File exists.",
  ])('a contended push: %s', (stderr) => {
    expect(isContended(result(stderr))).toBe(true);
  });

  it('a timed-out push is contended; a missing repository is not', () => {
    expect(isContended(result('', true))).toBe(true);
    expect(
      isContended(
        result("fatal: 'origin' does not appear to be a git repository"),
      ),
    ).toBe(false);
  });
});

describe('backoffMilliseconds', () => {
  it('jitters fully between 250 ms and a ceiling doubling to 5 s', () => {
    expect(backoffMilliseconds(1, () => 0)).toBe(250);
    expect(backoffMilliseconds(1, () => 1)).toBe(250);
    expect(backoffMilliseconds(3, () => 1)).toBe(1_000);
    expect(backoffMilliseconds(8, () => 1)).toBe(5_000);
    expect(backoffMilliseconds(8, () => 0.5)).toBe(2_625);
  });
});
