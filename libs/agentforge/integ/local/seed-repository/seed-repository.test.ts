/**
 * Seeding a host repository from its remote, against real git and an
 * `https://` remote: a bare repository served over git's dumb HTTP protocol
 * by a static server with a self-signed certificate, trusted through
 * `GIT_SSL_CAINFO` as the host's own git would trust its remote. Then a
 * GitFilesystem mounts the seeded history and pushes, as a served agent
 * does, and the remote is unchanged.
 */
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ServeTask,
  seedRepository,
} from '../../../src/plugin/executors/seed-repository/executor.ts';
import { GitFilesystem } from '../../../src/server/harness/filesystem/git-filesystem.ts';
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
  }).trim();
}

const TASKS: readonly ServeTask[] = [
  {
    project: 'rnd',
    projectRoot: 'apps/rnd',
    target: 'serve-writer',
    configuration: 'serve',
  },
  {
    project: 'flows',
    projectRoot: 'apps/flows',
    target: 'serve',
    configuration: 'local',
  },
];

let served: string;
let server: ChildProcess;
let remote: string;
let remoteTip: string;
let previousCaInfo: string | undefined;

beforeAll(async () => {
  served = mkdtempSync(join(tmpdir(), 'agentforge-seed-remote-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(served, 'key.pem'),
      '-out',
      join(served, 'cert.pem'),
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const source = join(served, 'repos', 'vault.git');
  const writer = join(served, 'writer');
  git(['init', '--quiet', '--bare', '--initial-branch=main', source], served);
  git(['clone', '--quiet', source, writer], served);
  git(['checkout', '--quiet', '-B', 'main'], writer);
  mkdirSync(join(writer, 'strategies'));
  writeFileSync(join(writer, 'strategies', 'alpha.md'), 'alpha');
  git(['add', '.'], writer);
  git(['commit', '--quiet', '-m', 'the remote'], writer);
  git(['push', '--quiet', 'origin', 'main'], writer);
  git(['update-server-info'], source);
  remoteTip = git(['rev-parse', 'main'], source);
  server = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('./__fixtures__/static-https-server.mjs', import.meta.url),
      ),
      join(served, 'repos'),
      join(served, 'key.pem'),
      join(served, 'cert.pem'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<string>((listening, failed) => {
    server.once('error', failed);
    server.stdout?.once('data', (chunk: Buffer) =>
      listening(chunk.toString().trim()),
    );
  });
  remote = `https://127.0.0.1:${port}/vault.git`;
  previousCaInfo = process.env.GIT_SSL_CAINFO;
  process.env.GIT_SSL_CAINFO = join(served, 'cert.pem');
});

afterAll(async () => {
  if (previousCaInfo === undefined) delete process.env.GIT_SSL_CAINFO;
  else process.env.GIT_SSL_CAINFO = previousCaInfo;
  server.kill();
  await rm(served, { recursive: true, force: true });
});

let workspace: string;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentforge-seed-workspace-'));
  git(['init', '--quiet', workspace], tmpdir());
  lines = [];
});

const hostPath = () =>
  join(workspace, '.agentforge', 'repositories', 'vault.git');

/** What a served agent's git filesystem does: mount the host repository, write, push. */
async function agentPushes(file: string, content: string): Promise<string> {
  const filesystem = new GitFilesystem(
    {
      localRoot: join(workspace, 'mounts', randomUUIDv7()),
      repository: 'vault',
      pushOn: ['TASK_STATE_COMPLETED'],
      scope: () => ({ subpath: '' }),
    },
    {
      environment: {
        AGENTFORGE_FILESYSTEM_REPOSITORIES: JSON.stringify({
          vault: `file://${hostPath()}`,
        }),
        AGENTFORGE_AGENT_NAME: 'tester',
      },
    },
  );
  const taskId = randomUUIDv7();
  const vault = await filesystem.mount(
    filesystem.resolve({
      name: 'vault',
      taskId,
      request: {
        input: {},
        context: {
          taskId,
          runtimeSessionId: randomUUIDv7(),
          idempotencyKey: 'k',
          attempt: 1,
        } as TaskContext<FrameworkTypes>,
      },
    }),
  );
  expect(
    readFileSync(
      join(vault.mounted.localPath, 'strategies', 'alpha.md'),
      'utf8',
    ),
  ).toBe('alpha');
  await writeFile(join(vault.mounted.localPath, file), content);
  await vault.unmount('TASK_STATE_COMPLETED');
  return git(['rev-parse', 'main'], hostPath());
}

describe('seed-repository', () => {
  it("seeds the default location from the remote, and a served agent's push stays on the host", async () => {
    seedRepository({ repository: 'vault', remote }, workspace, TASKS, log);
    expect(git(['rev-parse', '--is-bare-repository'], hostPath())).toBe('true');
    expect(git(['rev-parse', 'main'], hostPath())).toBe(remoteTip);
    expect(git(['config', 'uploadpack.allowFilter'], hostPath())).toBe('true');
    expect(readFileSync(join(workspace, '.env.serve'), 'utf8')).toBe(
      'AGENTFORGE_FILESYSTEM_REPOSITORIES={"vault":".agentforge/repositories/vault.git"}\n',
    );
    expect(
      spawnSync(
        'git',
        ['check-ignore', '--quiet', '.agentforge/repositories/vault.git/HEAD'],
        {
          cwd: workspace,
        },
      ).status,
    ).toBe(0);

    const pushed = await agentPushes('beta.md', 'beta');
    expect(git(['rev-parse', `${pushed}^`], hostPath())).toBe(remoteTip);
    expect(git(['rev-parse', 'main'], join(served, 'repos', 'vault.git'))).toBe(
      remoteTip,
    );
  });

  it('changes nothing when run again', () => {
    seedRepository({ repository: 'vault', remote }, workspace, TASKS, log);
    const snapshot = () => ({
      env: readFileSync(join(workspace, '.env.serve'), 'utf8'),
      gitignore: readFileSync(join(workspace, '.gitignore'), 'utf8'),
      config: readFileSync(join(hostPath(), 'config'), 'utf8'),
      refs: git(['show-ref'], hostPath()),
    });
    const before = snapshot();
    lines = [];
    seedRepository({ repository: 'vault', remote }, workspace, TASKS, log);
    expect(snapshot()).toEqual(before);
    expect(lines).toEqual([]);
  });

  it('adopts a bare clone of the remote made by hand, enabling partial clones', () => {
    mkdirSync(join(workspace, '.agentforge', 'repositories'), {
      recursive: true,
    });
    git(['clone', '--quiet', '--bare', remote, hostPath()], workspace);
    expect(
      spawnSync('git', ['config', 'uploadpack.allowFilter'], {
        cwd: hostPath(),
      }).status,
    ).toBe(1);
    seedRepository(
      { repository: 'vault', remote: `${remote}/` },
      workspace,
      TASKS,
      log,
    );
    expect(git(['config', 'uploadpack.allowFilter'], hostPath())).toBe('true');
    expect(lines).toContain(`Adopted ${hostPath()}, enabling partial clones`);
  });

  it('fails on a working clone at the location, naming it, and changes nothing', () => {
    git(['clone', '--quiet', remote, hostPath()], workspace);
    expect(() =>
      seedRepository({ repository: 'vault', remote }, workspace, TASKS, log),
    ).toThrow(`${hostPath()} is a working clone`);
    expect(existsSync(join(workspace, '.env.serve'))).toBe(false);
  });

  it('fails on a URL with userinfo before cloning', () => {
    const withUser = remote.replace('https://', 'https://someone:secret@');
    expect(() =>
      seedRepository(
        { repository: 'vault', remote: withUser },
        workspace,
        TASKS,
        log,
      ),
    ).toThrow(/carries a credential/);
    expect(existsSync(join(workspace, '.agentforge'))).toBe(false);
  });

  it('fails, naming the file, when a project would not see the declaration', () => {
    mkdirSync(join(workspace, 'apps', 'rnd'), { recursive: true });
    writeFileSync(
      join(workspace, 'apps', 'rnd', '.env.serve'),
      'AGENTFORGE_FILESYSTEM_REPOSITORIES={"notes":"notes.git"}\n',
    );
    expect(() =>
      seedRepository({ repository: 'vault', remote }, workspace, TASKS, log),
    ).toThrow(
      /rnd:serve-writer:serve would not see repository "vault".*apps\/rnd\/\.env\.serve/,
    );
    expect(existsSync(hostPath())).toBe(false);
  });

  it("creates a reading clone, and re-points one cloned from the remote; each fetches the agent's commit", async () => {
    const created = join(workspace, 'reading');
    seedRepository(
      { repository: 'vault', remote, readingClone: 'reading' },
      workspace,
      TASKS,
      log,
    );
    expect(git(['config', 'remote.origin.url'], created)).toBe(hostPath());

    const existing = join(workspace, 'existing');
    git(['clone', '--quiet', remote, existing], workspace);
    seedRepository(
      { repository: 'vault', remote, readingClone: existing },
      workspace,
      TASKS,
      log,
    );
    expect(git(['config', 'remote.origin.url'], existing)).toBe(hostPath());
    expect(lines.at(-1)).toContain(`it was ${remote}`);

    const pushed = await agentPushes('gamma.md', 'gamma');
    for (const reading of [created, existing]) {
      git(['fetch', '--quiet', 'origin'], reading);
      expect(git(['rev-parse', 'origin/main'], reading)).toBe(pushed);
    }
  });

  it('fails on a reading clone of another history, leaving it unchanged', () => {
    const unrelated = join(workspace, 'unrelated');
    git(['init', '--quiet', unrelated], workspace);
    git(['commit', '--quiet', '--allow-empty', '-m', 'unrelated'], unrelated);
    git(
      ['remote', 'add', 'origin', 'https://example.com/unrelated.git'],
      unrelated,
    );
    expect(() =>
      seedRepository(
        { repository: 'vault', remote, readingClone: unrelated },
        workspace,
        TASKS,
        log,
      ),
    ).toThrow(`${unrelated} shares no commit with ${hostPath()}`);
    expect(git(['config', 'remote.origin.url'], unrelated)).toBe(
      'https://example.com/unrelated.git',
    );
  });

  it('writes no credential into any file, config or line of output', () => {
    seedRepository(
      { repository: 'vault', remote, readingClone: 'reading' },
      workspace,
      TASKS,
      log,
    );
    const written = [
      readFileSync(join(workspace, '.env.serve'), 'utf8'),
      readFileSync(join(workspace, '.gitignore'), 'utf8'),
      readFileSync(join(hostPath(), 'config'), 'utf8'),
      readFileSync(join(workspace, 'reading', '.git', 'config'), 'utf8'),
      ...lines,
    ].join('\n');
    expect(written).not.toMatch(
      /extraheader|authorization|password|@127\.0\.0\.1/i,
    );
  });
});
