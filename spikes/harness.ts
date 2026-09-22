/**
 * Shared spike harness. Loads the operator's subscription token, gives each run
 * an isolated config directory and working directory, and records every SDK
 * message so a finding is evidence rather than a recollection.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikesRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(spikesRoot);

/** Reads .env.local from the repository root into process.env. Never printed. */
export function loadEnvironment(): void {
  const path = join(repositoryRoot, '.env.local');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const text = require('node:fs').readFileSync(path, 'utf8') as string;
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    process.env[match[1]!] = match[2]!;
  }
  // The operator may supply a short-lived token for a spike session and revoke
  // it afterwards. Prefer it when present, so a spike never uses the standing
  // one by accident.
  if (process.env.TEMP_CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env.TEMP_CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.startsWith('sk-ant-')) {
    throw new Error('no usable token: set TEMP_CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN in .env.local');
  }
}

export type Sandbox = {
  configDirectory: string;
  workingDirectory: string;
  dispose(): void;
};

/** A throwaway CLAUDE_CONFIG_DIR and cwd, so a spike never touches the operator's own. */
export function createSandbox(name: string): Sandbox {
  const base = join(spikesRoot, '.sandboxes', `${name}-${Date.now()}`);
  const configDirectory = join(base, 'config');
  const workingDirectory = join(base, 'work');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  // A settings file that keeps the sandbox from inheriting anything ambient.
  writeFileSync(join(configDirectory, 'settings.json'), JSON.stringify({}, null, 2));
  return {
    configDirectory,
    workingDirectory,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

export type RecordedRun = {
  messages: unknown[];
  result: Record<string, unknown> | undefined;
  toolNames: string[];
  systemInit: Record<string, unknown> | undefined;
  durationMs: number;
};

/** Drains a query, keeping every message. */
export async function record(
  iterator: AsyncIterable<any>,
  onMessage?: (message: any) => void,
): Promise<RecordedRun> {
  const started = Date.now();
  const messages: unknown[] = [];
  const toolNames: string[] = [];
  let result: Record<string, unknown> | undefined;
  let systemInit: Record<string, unknown> | undefined;
  for await (const message of iterator) {
    messages.push(message);
    onMessage?.(message);
    if (message.type === 'result') result = message;
    if (message.type === 'system' && message.subtype === 'init') systemInit = message;
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_use') toolNames.push(block.name);
      }
    }
  }
  return { messages, result, toolNames, systemInit, durationMs: Date.now() - started };
}

/** Writes the full message log beside the spike, for evidence. */
export function writeLog(name: string, run: RecordedRun): string {
  const directory = join(spikesRoot, 'out');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.jsonl`);
  writeFileSync(path, run.messages.map((m) => JSON.stringify(m)).join('\n'));
  return path;
}

export const findings: { name: string; verdict: string; detail: string }[] = [];

export function finding(name: string, verdict: string, detail: string): void {
  findings.push({ name, verdict, detail });
  console.log(`\n[${verdict}] ${name}\n         ${detail.replace(/\n/g, '\n         ')}`);
}

export function reportFindings(): void {
  console.log('\n========== FINDINGS ==========');
  for (const f of findings) console.log(`${f.verdict.padEnd(12)} ${f.name}`);
  console.log('==============================\n');
}
