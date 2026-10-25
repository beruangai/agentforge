import type { ChildProcess } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedUserScope, spawnWithUserScope } from './user-scope.ts';

let user: string;
let resume: string;

/** A user config directory as an image installs one, and the SDK's resume directory beside it. */
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'user-scope-'));
  user = join(root, 'user');
  resume = join(root, 'claude-resume');
  mkdirSync(join(user, 'plugins'), { recursive: true });
  mkdirSync(join(user, 'skills'));
  mkdirSync(join(user, 'projects'));
  writeFileSync(join(user, 'CLAUDE.md'), '# user');
  writeFileSync(join(user, '.credentials.json'), '{"user":true}');
  writeFileSync(
    join(user, 'settings.json'),
    JSON.stringify({
      enabledPlugins: { 'probe@local': true },
      extraKnownMarketplaces: { local: { source: { source: 'directory' } } },
      env: { CLAUDE_CONFIG_DIR: user, KEPT: '1' },
    }),
  );
  // What the SDK wrote: the transcript, the credentials, the settings without plugins.
  mkdirSync(join(resume, 'projects', 'key'), { recursive: true });
  writeFileSync(join(resume, '.credentials.json'), '{"sdk":true}');
  writeFileSync(
    join(resume, 'settings.json'),
    JSON.stringify({ env: { KEPT: '1' } }),
  );
});

describe('seedUserScope', () => {
  it('links the user scope in, leaving what the SDK wrote', () => {
    seedUserScope(user, resume);
    for (const name of ['plugins', 'skills', 'CLAUDE.md']) {
      expect(lstatSync(join(resume, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(resume, name))).toBe(join(user, name));
    }
    expect(lstatSync(join(resume, 'projects')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(resume, '.credentials.json'), 'utf8')).toBe(
      '{"sdk":true}',
    );
  });

  it("gives the SDK's settings back the user's plugin settings, and nothing it removed besides", () => {
    seedUserScope(user, resume);
    expect(
      JSON.parse(readFileSync(join(resume, 'settings.json'), 'utf8')),
    ).toEqual({
      env: { KEPT: '1' },
      enabledPlugins: { 'probe@local': true },
      extraKnownMarketplaces: { local: { source: { source: 'directory' } } },
    });
  });

  it('leaves a settings file that is not JSON as the SDK copied it', () => {
    writeFileSync(join(user, 'settings.json'), '// not json');
    writeFileSync(join(resume, 'settings.json'), '// not json');
    seedUserScope(user, resume);
    expect(readFileSync(join(resume, 'settings.json'), 'utf8')).toBe(
      '// not json',
    );
  });

  it('gives nothing when there is no user config directory', () => {
    expect(() => seedUserScope(join(user, 'missing'), resume)).not.toThrow();
  });
});

describe('spawnWithUserScope', () => {
  const CHILD = {} as SpawnedProcess;
  const spawnOptions = (env: Record<string, string>): SpawnOptions => ({
    command: 'claude',
    args: [],
    env,
    signal: new AbortController().signal,
  });

  it('seeds the config directory the SDK swapped in, then spawns by the procedure’s own spawn', () => {
    const own = vi.fn(() => CHILD);
    const spawned = spawnWithUserScope(user, {
      spawnClaudeCodeProcess: own,
      stderr: () => {},
    })(spawnOptions({ CLAUDE_CONFIG_DIR: resume }));
    expect(spawned).toBe(CHILD);
    expect(own).toHaveBeenCalledWith(
      expect.objectContaining({ env: { CLAUDE_CONFIG_DIR: resume } }),
    );
    expect(lstatSync(join(resume, 'plugins')).isSymbolicLink()).toBe(true);
  });

  it('seeds nothing when the run kept the user config directory', () => {
    spawnWithUserScope(user, {
      spawnClaudeCodeProcess: () => CHILD,
      stderr: () => {},
    })(spawnOptions({ CLAUDE_CONFIG_DIR: user }));
    expect(() => lstatSync(join(resume, 'plugins'))).toThrow();
  });

  it("spawns the CLI as the SDK does, its stderr to the run's", async () => {
    const stderr = vi.fn();
    const child = spawnWithUserScope(user, {
      spawnClaudeCodeProcess: undefined,
      stderr,
    })({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("cli says")'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: resume },
      signal: new AbortController().signal,
    });
    await new Promise((resolve) =>
      (child as ChildProcess).stderr?.once('close', resolve),
    );
    expect(stderr.mock.calls.join('')).toContain('cli says');
  });
});
