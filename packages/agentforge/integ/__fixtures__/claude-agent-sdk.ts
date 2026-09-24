/**
 * Shared Agent SDK fixtures for the integ tier. Resolves the
 * operator's subscription token, gives each run an isolated config directory
 * and working directory, runs a query in the kernel's input mode, and records
 * every SDK message so a failing assertion points at evidence rather than a
 * recollection.
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
import { taskOutputDirectory } from './task-output-directory.ts';

/**
 * The operator's subscription token. `TEMP_CLAUDE_CODE_OAUTH_TOKEN` is
 * preferred when present: it is a short-lived token supplied for one session
 * and revoked afterwards, so a run never uses the standing one by accident.
 * Nx loads both from `.env.integ.local` into the `integ` task alone; no other
 * task receives a token.
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
      'neither TEMP_CLAUDE_CODE_OAUTH_TOKEN nor CLAUDE_CODE_OAUTH_TOKEN is set in process.env; run through `nx run @beruangai/agentforge:integ --configuration=model`, which loads them from .env.integ.local',
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

/**
 * The tool that carries a structured-output submission under
 * `outputFormat: { type: 'json_schema' }` — its emitted name, advertised in
 * `system/init.tools` (docs/research/kernel-settlement.md).
 */
export const carrierToolName = 'StructuredOutput';

/**
 * What the kernel passes through `env` on every query: removes
 * `run_in_background` from Bash and the subagent tool, and turns off
 * auto-backgrounding (docs/ARCHITECTURE.md §7).
 */
export const backgroundWorkDisabled: Record<string, string> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

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
 * `dist/packages/agentforge/integ/<concept>/<name>.jsonl` as it arrives, so the
 * evidence survives a throw or a timeout.
 */
export class QueryRecording {
  readonly messages: SDKMessage[] = [];
  readonly logPath: string;

  constructor(concept: string, name: string) {
    const directory = join(taskOutputDirectory(), concept);
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

  /**
   * Appends how draining ended when a test records it rather than asserting
   * it — the error's text, or that it ended without one.
   */
  appendDrainOutcome(drainError: unknown): void {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ type: 'drain_outcome', threw: drainError !== undefined, error: drainError === undefined ? null : String(drainError) })}\n`,
    );
  }

  resultMessages(): SDKResultMessage[] {
    return this.messages.filter(
      (message): message is SDKResultMessage => message.type === 'result',
    );
  }

  /** The only result of the run; throws if there is not exactly one. */
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
  // biome-ignore lint/correctness/useYield: a prompt that never yields is the point — no turn may start.
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

  // The drain's own failure, captured rather than awaited raw, so that a
  // failure reading the session start is never replaced by a second one.
  const drainFailure = drained.then(
    () => undefined,
    (error: unknown) => error,
  );
  const endSession = async (): Promise<unknown> => {
    session.close();
    releasePrompt();
    return drainFailure;
  };

  let initializationResult: SDKControlInitializeResponse;
  try {
    initializationResult = await session.initializationResult();
    recording.appendControlResponse('initialize', initializationResult);
    if (awaitSessionStartHooks) {
      await awaitHookBatch();
    }
  } catch (error) {
    const drainError = await endSession();
    throw drainError === undefined
      ? error
      : new AggregateError(
          [error, drainError],
          `reading the session start failed, and so did draining the session; see ${recording.logPath}`,
        );
  }
  const drainError = await endSession();
  if (drainError !== undefined) throw drainError;

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
  return { initializationResult, sessionStartHookResponses };

  async function awaitHookBatch(): Promise<void> {
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
}

export type StreamingPrompt = {
  /** Yields one user message, then holds the input open until `endInput`. */
  prompt: AsyncIterable<SDKUserMessage>;
  /** Ends the input: the prompt returns, and the SDK closes the CLI's stdin. Idempotent. */
  endInput: () => void;
};

/**
 * The kernel's input mode: a streaming prompt that yields one user message —
 * a string or content blocks — and then stays open, as
 * `readSessionStartWithoutATurn`'s never-yielding prompt does, until the
 * caller ends it.
 */
export function createStreamingPrompt(
  content: SDKUserMessage['message']['content'],
): StreamingPrompt {
  const { promise: inputEnded, resolve: endInput } =
    Promise.withResolvers<void>();
  async function* promptThatStaysOpen(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    await inputEnded;
  }
  return { prompt: promptThatStaysOpen(), endInput: () => endInput() };
}

/**
 * Decides, per message, when to end the input. The kernel ends it on the first
 * result, which is the default.
 */
export type EndInputPolicy = (
  message: SDKMessage,
  endInput: () => void,
) => void;

export const endInputOnFirstResult: EndInputPolicy = (message, endInput) => {
  if (message.type === 'result') endInput();
};

/** How long the process may take to exit once its input has ended. */
const exitBoundMilliseconds = 60_000;

/** The process was still running `exitBoundMilliseconds` after its input ended. */
export class ProcessOutlivedItsInputError extends Error {}

/**
 * Runs one query the way the kernel does: streaming input and output, one
 * user message, the input held open until `endInputPolicy` ends it, then read
 * to process exit under a bound. A throw from the iterator propagates
 * unchanged; a process that outlives the bound is closed and fails the run.
 */
export async function runWithStreamingInput(
  recording: QueryRecording,
  content: SDKUserMessage['message']['content'],
  options: Options,
  endInputPolicy: EndInputPolicy = endInputOnFirstResult,
): Promise<void> {
  const input = createStreamingPrompt(content);
  const { promise: inputEnded, resolve: markInputEnded } =
    Promise.withResolvers<void>();
  const endInput = (): void => {
    input.endInput();
    markInputEnded();
  };

  const session = query({ prompt: input.prompt, options });
  const drained = recording.drain(session, (message) =>
    endInputPolicy(message, endInput),
  );
  // Captured, so a drain that fails after the bound fired is reported with it
  // rather than as an unhandled rejection.
  const drainFailure = drained.then(
    () => undefined,
    (error: unknown) => error,
  );
  const exitBoundTimer = new AbortController();

  try {
    await Promise.race([drained, failWhenTheProcessOutlivesItsInput()]);
  } finally {
    exitBoundTimer.abort();
    input.endInput();
  }

  async function failWhenTheProcessOutlivesItsInput(): Promise<void> {
    await inputEnded;
    try {
      await delay(exitBoundMilliseconds, undefined, {
        signal: exitBoundTimer.signal,
      });
    } catch (error) {
      if (exitBoundTimer.signal.aborted) return;
      throw error;
    }
    session.close();
    throw new ProcessOutlivedItsInputError(
      `the process did not exit within ${exitBoundMilliseconds} ms of its input ending; see ${recording.logPath}`,
      { cause: await drainFailure },
    );
  }
}
