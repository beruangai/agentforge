/**
 * Shared Agent SDK fixtures for the integ and e2e tiers. Resolves the
 * operator's subscription token, gives each run an isolated config directory
 * and working directory, and records every SDK message so a failing assertion
 * points at evidence rather than a recollection.
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type Options,
  query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type TestTier, taskOutputDirectory } from './task-output-directory.ts';

/**
 * The operator's subscription token. `TEMP_CLAUDE_CODE_OAUTH_TOKEN` is
 * preferred when present: it is a short-lived token supplied for one session
 * and revoked afterwards, so a run never uses the standing one by accident.
 * Nx loads both from `.env` and `.env.local` into the task's environment.
 */
export function resolveClaudeCodeOAuthToken(): string {
  const temporaryToken = process.env.TEMP_CLAUDE_CODE_OAUTH_TOKEN;
  if (temporaryToken !== undefined) {
    if (!temporaryToken.startsWith('sk-ant-')) {
      throw new Error(
        'TEMP_CLAUDE_CODE_OAUTH_TOKEN is set but does not start with "sk-ant-"',
      );
    }
    return temporaryToken;
  }
  const standingToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (standingToken === undefined) {
    throw new Error(
      'neither TEMP_CLAUDE_CODE_OAUTH_TOKEN nor CLAUDE_CODE_OAUTH_TOKEN is set in process.env; run through `nx run @beruangai/agentforge:e2e`, which loads them from .env.local',
    );
  }
  if (!standingToken.startsWith('sk-ant-')) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is set but does not start with "sk-ant-"',
    );
  }
  return standingToken;
}

export type Sandbox = {
  configDirectory: string;
  workingDirectory: string;
  dispose(): void;
};

/**
 * A throwaway `CLAUDE_CONFIG_DIR` and working directory under the OS temporary
 * directory, so a run never touches the operator's own configuration and no
 * ancestor of the working directory is this repository.
 */
export function createSandbox(name: string): Sandbox {
  const base = mkdtempSync(join(tmpdir(), `agentforge-${name}-`));
  const configDirectory = join(base, 'config');
  const workingDirectory = join(base, 'work');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  // A settings file that keeps the sandbox from inheriting anything ambient.
  writeFileSync(
    join(configDirectory, 'settings.json'),
    JSON.stringify({}, null, 2),
  );
  return {
    configDirectory,
    workingDirectory,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** The environment for a run billed to the operator's subscription. */
export function createSubscriptionEnvironment(
  configDirectory: string,
  additionalVariables: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: resolveClaudeCodeOAuthToken(),
    CLAUDE_CONFIG_DIR: configDirectory,
    ...additionalVariables,
  };
}

const credentialVariablePattern = /^(ANTHROPIC_|CLAUDE_|TEMP_CLAUDE_)/;

/**
 * The environment for a run that must never reach a model: every
 * `ANTHROPIC_*`, `CLAUDE_*` and `TEMP_CLAUDE_*` variable is removed, so the
 * CLI starts with no credential at all. A test using it asserts
 * `initializationResult().account.tokenSource === 'none'` to prove it.
 */
export function createEnvironmentWithoutCredentials(
  configDirectory: string,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!credentialVariablePattern.test(name)) environment[name] = value;
  }
  environment.CLAUDE_CONFIG_DIR = configDirectory;
  return environment;
}

export type ToolUse = { id: string; name: string; input: unknown };
export type ToolResult = {
  toolUseId: string;
  isError: boolean;
  text: string;
};

/**
 * Every message of one run, appended to
 * `dist/packages/agentforge/<tier>/<concept>/<name>.jsonl` as it arrives, so the evidence survives
 * a throw or a timeout.
 */
export class QueryRecording {
  readonly messages: SDKMessage[] = [];
  readonly logPath: string;

  constructor(tier: TestTier, concept: string, name: string) {
    const directory = join(taskOutputDirectory(tier), concept);
    mkdirSync(directory, { recursive: true });
    this.logPath = join(directory, `${name}.jsonl`);
    writeFileSync(this.logPath, '');
  }

  /** Drains a query, keeping every message. A throw propagates unchanged. */
  async drain(
    iterator: AsyncIterable<SDKMessage>,
    onMessage?: (message: SDKMessage) => void,
  ): Promise<void> {
    for await (const message of iterator) {
      this.messages.push(message);
      appendFileSync(this.logPath, `${JSON.stringify(message)}\n`);
      onMessage?.(message);
    }
  }

  /**
   * Appends a record that is not an SDK message — a control response the
   * test read — so the log holds every fact the assertions rest on.
   */
  appendControlResponse(subtype: string, response: unknown): void {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ type: 'control_response', subtype, response })}\n`,
    );
  }

  resultMessages(): SDKResultMessage[] {
    return this.messages.filter(
      (message): message is SDKResultMessage => message.type === 'result',
    );
  }

  /** The only result of a closed-input run; throws if there is not exactly one. */
  onlyResultMessage(): SDKResultMessage {
    const results = this.resultMessages();
    if (results.length !== 1) {
      throw new Error(
        `expected exactly one result message, got ${results.length}; see ${this.logPath}`,
      );
    }
    return results[0] as SDKResultMessage;
  }

  systemInitMessages(): SDKSystemMessage[] {
    return this.messages.filter(
      (message): message is SDKSystemMessage =>
        message.type === 'system' && message.subtype === 'init',
    );
  }

  /** The first `system/init`; throws if the run emitted none. */
  firstSystemInitMessage(): SDKSystemMessage {
    const [first] = this.systemInitMessages();
    if (first === undefined) {
      throw new Error(`the run emitted no system/init; see ${this.logPath}`);
    }
    return first;
  }

  /** Every `tool_use` block the main thread and its subagents emitted. */
  toolUses(): ToolUse[] {
    const toolUses: ToolUse[] = [];
    for (const message of this.messages) {
      if (message.type !== 'assistant') continue;
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }
    return toolUses;
  }

  toolUseNames(): string[] {
    return this.toolUses().map((toolUse) => toolUse.name);
  }

  /** Every `tool_result` block, with its content flattened to text. */
  toolResults(): ToolResult[] {
    const toolResults: ToolResult[] = [];
    for (const message of this.messages) {
      if (message.type !== 'user') continue;
      const content = message.message.content;
      if (typeof content === 'string') continue;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const text =
          typeof block.content === 'string'
            ? block.content
            : (block.content ?? [])
                .map((part) => (part.type === 'text' ? part.text : ''))
                .join('');
        toolResults.push({
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          text,
        });
      }
    }
    return toolResults;
  }
}

export type SessionStart = {
  initializationResult: SDKControlInitializeResponse;
  /** `hook_response` messages for `SessionStart`, one per hook that ran. */
  sessionStartHookResponses: SDKMessage[];
};

/**
 * Starts a session and reads what it loaded, without ever sending a turn.
 *
 * The prompt is a streaming-input iterable that never yields, so no user
 * message reaches the CLI and no model request can be made. The CLI still
 * completes its `initialize` handshake — whose response lists the slash
 * commands (skills included) and subagents it discovered — and runs its
 * `SessionStart` hooks, whose `hook_started` / `hook_response` messages are
 * emitted whatever `Options.includeHookEvents` says. `system/init` is NOT emitted:
 * the SDK documents it as the start of a turn. Then `close()` ends the process.
 *
 * With `awaitSessionStartHooks`, it waits until the first `SessionStart` hook
 * batch has settled — every `hook_started` answered by a `hook_response` —
 * and fails, rather than guessing, if none arrives within the window.
 */
export async function readSessionStartWithoutATurn(
  options: Options,
  recording: QueryRecording,
  awaitSessionStartHooks: boolean,
): Promise<SessionStart> {
  const { promise: promptReleased, resolve: releasePrompt } =
    Promise.withResolvers<void>();
  async function* promptThatNeverYields(): AsyncGenerator<SDKUserMessage> {
    await promptReleased;
  }

  const startedHookIds = new Set<string>();
  const answeredHookIds = new Set<string>();
  const sessionStartHookResponses: SDKMessage[] = [];
  const { promise: hooksSettled, resolve: markHooksSettled } =
    Promise.withResolvers<void>();

  const session = query({ prompt: promptThatNeverYields(), options });
  const drained = recording.drain(session, (message) => {
    if (message.type !== 'system') return;
    if (
      message.subtype === 'hook_started' &&
      message.hook_event === 'SessionStart'
    ) {
      startedHookIds.add(message.hook_id);
    }
    if (
      message.subtype === 'hook_response' &&
      message.hook_event === 'SessionStart'
    ) {
      answeredHookIds.add(message.hook_id);
      sessionStartHookResponses.push(message);
      if ([...startedHookIds].every((hookId) => answeredHookIds.has(hookId))) {
        markHooksSettled();
      }
    }
  });

  try {
    const initializationResult = await session.initializationResult();
    recording.appendControlResponse('initialize', initializationResult);
    if (awaitSessionStartHooks) {
      const windowMilliseconds = 30_000;
      const windowTimer = new AbortController();
      try {
        await Promise.race([
          hooksSettled,
          delay(windowMilliseconds, undefined, {
            signal: windowTimer.signal,
          }).then(() => {
            throw new Error(
              `no SessionStart hook batch settled within ${windowMilliseconds} ms (started ${startedHookIds.size}, answered ${answeredHookIds.size}); see ${recording.logPath}`,
            );
          }),
        ]);
      } finally {
        windowTimer.abort();
      }
    }
    return { initializationResult, sessionStartHookResponses };
  } finally {
    session.close();
    releasePrompt();
    await drained;
    const turnMessages = recording.messages.filter(
      (message) =>
        message.type === 'assistant' ||
        message.type === 'result' ||
        (message.type === 'system' && message.subtype === 'init'),
    );
    if (turnMessages.length > 0) {
      throw new Error(
        `a turn ran although no prompt was sent (${turnMessages.map((message) => message.type).join(', ')}); see ${recording.logPath}`,
      );
    }
    const unansweredHookIds = [...startedHookIds].filter(
      (hookId) => !answeredHookIds.has(hookId),
    );
    if (awaitSessionStartHooks && unansweredHookIds.length > 0) {
      throw new Error(
        `SessionStart hooks started after the batch was taken as settled: ${unansweredHookIds.join(', ')}; see ${recording.logPath}`,
      );
    }
  }
}
