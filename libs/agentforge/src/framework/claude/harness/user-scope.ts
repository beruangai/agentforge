import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Options,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

/** What the SDK writes into a resumed run's config directory itself, never linked over. */
const SEEDED_BY_THE_SDK = new Set(['projects', '.credentials.json']);
/** The user settings the SDK leaves out of a resumed run's `settings.json`. */
const PLUGIN_SETTINGS = [
  'enabledPlugins',
  'extraKnownMarketplaces',
  'additionalMarketplaces',
] as const;

/** Claude's user config directory as a fresh run reads it. */
export function userConfigDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/**
 * Gives a resumed run's config directory the image's Claude user scope. The
 * SDK resumes a session from the store in a directory of its own
 * (`CLAUDE_CONFIG_DIR=/tmp/claude-resume-<uuid>`) seeded with the transcript,
 * the credentials, `.claude.json` and the user `settings.json` without its
 * plugin settings (SDK 0.3.280, docs/research/claude-agent-sdk.md), so the
 * user scope's plugins, skills, agents and `CLAUDE.md` would be missing.
 * Every other entry of the user config directory is linked in, so the run
 * reads and writes the user scope as a fresh run does, and the SDK's
 * `settings.json` takes back the user's plugin settings. A user config
 * directory that does not exist has nothing to give.
 */
export function seedUserScope(
  userDirectory: string,
  resumeDirectory: string,
): void {
  if (!existsSync(userDirectory)) return;
  for (const name of readdirSync(userDirectory)) {
    if (SEEDED_BY_THE_SDK.has(name)) continue;
    const seeded = join(resumeDirectory, name);
    if (name === 'settings.json') {
      restorePluginSettings(join(userDirectory, name), seeded);
    } else if (!existsSync(seeded)) {
      symlinkSync(join(userDirectory, name), seeded);
    }
  }
}

/**
 * The user's plugin settings, back in the SDK's copy of `settings.json`. A
 * file that is not JSON the SDK copied as it was, leaving nothing out.
 */
function restorePluginSettings(user: string, seeded: string): void {
  const original = jsonObject(readFileSync(user, 'utf8'));
  const copy = existsSync(seeded)
    ? jsonObject(readFileSync(seeded, 'utf8'))
    : {};
  if (original === undefined || copy === undefined) return;
  for (const key of PLUGIN_SETTINGS) {
    if (Object.hasOwn(original, key)) copy[key] = original[key];
  }
  writeFileSync(seeded, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The CLI's spawn for a run that resumes from a store: when the SDK has
 * swapped the config directory, it is seeded with the user scope first, then
 * the CLI starts as the SDK's own spawn starts it — or by the procedure's
 * spawn — its stderr to `stderr`, which the SDK reads only from its own.
 */
export function spawnWithUserScope(
  userDirectory: string,
  options: {
    readonly spawnClaudeCodeProcess: Options['spawnClaudeCodeProcess'];
    readonly stderr: (data: string) => void;
  },
): (spawnOptions: SpawnOptions) => SpawnedProcess {
  return (spawnOptions) => {
    const configDirectory = spawnOptions.env.CLAUDE_CONFIG_DIR;
    if (configDirectory !== undefined && configDirectory !== userDirectory) {
      seedUserScope(userDirectory, configDirectory);
    }
    if (options.spawnClaudeCodeProcess !== undefined) {
      return options.spawnClaudeCodeProcess(spawnOptions);
    }
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', options.stderr);
    return child;
  };
}
