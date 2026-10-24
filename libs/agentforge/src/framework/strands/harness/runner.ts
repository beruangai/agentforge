import { randomUUIDv7 } from 'node:crypto';
import {
  AfterModelCallEvent,
  Agent,
  type AgentResult,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  DefaultModelRetryStrategy,
  type McpClient,
  type Message,
  type Plugin,
  SessionManager,
  type ToolList,
} from '@strands-agents/sdk';
import {
  AnthropicModel,
  type AnthropicModelOptions,
} from '@strands-agents/sdk/models/anthropic';
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import { hash as ohash } from 'ohash';
import { z } from 'zod';
import {
  type Cause,
  cause,
  type RunRecord,
  type RunUsage,
} from '#core/contract/task.ts';
import type { RunEnvironment } from '../../../server/harness/framework.ts';
import { validateStructuredOutput } from '../../../server/harness/structured-output-validation.ts';
import {
  describeError,
  TaskCanceled,
  TaskFailure,
} from '../../../server/harness/task-failure.ts';
import { STRANDS_SDK_FULL_NAME } from '../core/sdk-version.ts';
import { sessionPrefix } from '../core/session-keys.ts';
import { classify, isSpendLimit, strandsCause } from './classify.ts';
import { readLayers } from './layers.ts';
import { renderPrompt } from './prompt.ts';
import { type AgentStorage, recordingStorage } from './storage.ts';
import {
  composeSystemPrompt,
  STRUCTURED_OUTPUT_TOOL,
} from './system-prompt.ts';
import type { AgentRun, AgentRunSpec, StrandsOptions } from './types.ts';

export { STRUCTURED_OUTPUT_TOOL } from './system-prompt.ts';

/** How many structured outputs an agent may submit before the run fails, as the Claude CLI allows (§REQ208). */
export const DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS = 5;

/** The property a non-object agent contract is nested under, when a run opts in. */
export const STRUCTURED_OUTPUT_WRAPPER_KEY = 'output';

/** The Anthropic client's settings the runner owns, refused in a run's `modelConfig`. */
const RUNNER_OWNED_CLIENT_KEYS = ['apiKey', 'client', 'clientConfig'] as const;

/** Told to the agent in place of a tool's result once the run is ending. */
const RUN_ENDING = 'Stop: this run is ending.';

/** What a `strands` task process runs its agent runs with. */
export interface RunnerContext {
  /** The Anthropic API key (§REQ714). */
  readonly apiKey: string;
  /** The layers' directories, base first: the agent's cwd's parent, then the cwd. */
  readonly layers: readonly string[];
  /** The deployment's storage; none where no bucket is named. */
  readonly storage?: AgentStorage;
  /** A test seam: where the Anthropic client sends, and its own retries. */
  readonly clientConfig?: AnthropicModelOptions['clientConfig'];
  /** A test seam: `null` turns the SDK's retries off. */
  readonly retryStrategy?: null;
  /** The agent's name, on its spans as `gen_ai.agent.name`. */
  readonly agentName?: string;
  /** Exports what telemetry the run left buffered, before the task process exits. */
  readonly flushTelemetry?: () => Promise<void>;
}

/**
 * Throttled model calls are retried, as the SDK does — except the account's
 * spend cap, which no retry within a run can pass.
 */
class RetryUnlessSpendLimited extends DefaultModelRetryStrategy {
  override isRetryable(error: Error): boolean {
    return super.isRetryable(error) && !isSpendLimit(error);
  }
}

/**
 * One Strands invocation to a settled, typed outcome (ARCHITECTURE.md §6).
 *
 * The first structured output the contract and every stop guard accept is
 * the outcome. A submission they refuse is told to the agent in its turn, up
 * to the run's cap. A run that ends its turn without one fails before Strands
 * would force the tool. Whatever ends the run early — the cap, a guard that
 * throws, a write the storage refused — is recorded as its cause, and the
 * invocation cancelled. The outcome is classified from fields (§REQ501).
 */
export async function runAgent<Output>(
  spec: AgentRunSpec<Output>,
  environment: RunEnvironment,
  context: RunnerContext,
): Promise<AgentRun<Output>> {
  if (environment.signal.aborted) throw new TaskCanceled();
  const startedAt = Date.now();
  const options = spec.options ?? {};
  const owned = ownedByTheRunner(spec, context);
  const cwd = process.cwd();
  const [prompt, layers] = await Promise.all([
    renderPrompt(spec.prompt, cwd),
    readLayers(options.layers === false ? [] : context.layers),
  ]);
  if (environment.signal.aborted) throw new TaskCanceled();
  const systemPrompt = composeSystemPrompt(spec, layers.instructions);
  const promptHash = ohash(prompt);
  // The prompt as sent, whole, in the container log (§REQ601); the record
  // carries its hash.
  console.log(
    JSON.stringify({
      event: 'agentforge.prompt',
      promptHash,
      prompt,
      systemPrompt,
    }),
  );

  const sessionId = spec.resume ?? randomUUIDv7();
  if (spec.resume !== undefined) {
    await refuseUnknownSession(spec.resume, context.storage);
  }
  const mcpClients = options.mcpClients ?? {};
  try {
    await connectMcpClients(mcpClients, environment.signal);

    let ended: Cause | undefined;
    let accepted: { readonly value: Output } | undefined;
    let lastRefusal: string | undefined;
    let attempts = 0;
    let agent: Agent | undefined;
    const end = (reason: Cause): void => {
      ended ??= reason;
      agent?.cancel();
    };
    const storage =
      context.storage === undefined
        ? undefined
        : recordingStorage(context.storage.storage, (operation, key, error) =>
            end(
              cause(
                'EXECUTION_ERROR',
                `the agent's storage refused a ${operation} of "${key}": ${describeError(error)}`,
              ),
            ),
          );

    agent = new Agent({
      model: new AnthropicModel({
        ...options.modelConfig,
        apiKey: context.apiKey,
        modelId: owned.model,
        ...(options.maxTokens === undefined
          ? {}
          : { maxTokens: options.maxTokens }),
        // The provider does not pass the run's cancel to its request, so a
        // cancel mid-call would wait for the model; the request takes it here.
        clientConfig: {
          ...context.clientConfig,
          fetch: (input: string | URL | Request, init: RequestInit = {}) => {
            const signals = [
              ...(init.signal ? [init.signal] : []),
              ...(agent === undefined ? [] : [agent.cancelSignal]),
            ];
            return fetch(input, { ...init, signal: AbortSignal.any(signals) });
          },
        },
      }),
      systemPrompt,
      tools: [...(options.tools ?? []), ...Object.values(mcpClients)],
      plugins: [
        ...(options.plugins ?? []),
        ...(layers.skillDirectories.length === 0
          ? []
          : [new AgentSkills({ skills: [...layers.skillDirectories] })]),
        ...(storage === undefined || spec.offload === undefined
          ? []
          : [
              new ContextOffloader({
                storage,
                maxResultTokens: spec.offload.maxResultTokens,
                // Never evicted: the agent's role may not delete, and the SDK
                // swallows a refused delete. The bucket's retention keeps them.
                evictAfterCycles: null,
                ...(spec.offload.previewTokens === undefined
                  ? {}
                  : { previewTokens: spec.offload.previewTokens }),
              }) as Plugin,
            ]),
      ],
      ...(options.interventions === undefined
        ? {}
        : { interventions: [...options.interventions] }),
      ...(options.conversationManager === undefined
        ? {}
        : { conversationManager: options.conversationManager }),
      structuredOutputSchema: owned.wire,
      ...(storage === undefined
        ? {}
        : { storage, sessionManager: new SessionManager({ sessionId }) }),
      ...(storage === undefined || spec.memorySpace === undefined
        ? {}
        : {
            memoryManager: {
              stores: [
                new FileMemoryStore({
                  name: spec.memorySpace,
                  writable: true,
                  extraction: false,
                  storage,
                }),
              ],
              addToolConfig: true,
            },
          }),
      retryStrategy:
        context.retryStrategy === null ? null : new RetryUnlessSpendLimited(),
      ...(context.agentName === undefined ? {} : { name: context.agentName }),
      printer: false,
    });

    // One submission is validated at a time, in the order the agent made them,
    // so the first accepted is the outcome whichever tool call finishes first.
    let validated: Promise<unknown> = Promise.resolve();
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name !== STRUCTURED_OUTPUT_TOOL) return;
      const turn = validated.then(async () => {
        if (ended !== undefined || accepted !== undefined) {
          event.cancel = RUN_ENDING;
          return;
        }
        attempts += 1;
        const submission = owned.unwrap(event.toolUse.input);
        let refusal: string | undefined;
        try {
          refusal = await validateStructuredOutput(
            { output: spec.output, guards: spec.guardrails?.stop ?? [] },
            submission,
          );
        } catch (error) {
          // A guard that throws is a defect, never told to the agent.
          event.cancel = RUN_ENDING;
          end(
            cause(
              'EXECUTION_ERROR',
              `a stop guard threw while the structured output was validated: ${describeError(error)}`,
            ),
          );
          return;
        }
        if (refusal === undefined) {
          accepted = { value: await spec.output.parseAsync(submission) };
          return;
        }
        lastRefusal = refusal;
        event.cancel = refusal;
        if (attempts >= owned.maxAttempts) {
          end(
            cause(
              'OUTPUT_INVALID',
              `the agent could not produce accepted structured output in ${attempts} attempts; the last was refused: ${refusal}`,
              { payload: submission },
            ),
          );
        }
      });
      validated = turn;
      return turn;
    });
    // An accepted submission Strands did not settle on — not the first in its
    // message — still ends the run.
    agent.addHook(BeforeModelCallEvent, (event) => {
      if (accepted === undefined) return;
      event.cancel = RUN_ENDING;
      agent?.cancel();
    });
    // A turn ended without an accepted submission: Strands would force the
    // tool next, which the current models refuse.
    agent.addHook(AfterModelCallEvent, (event) => {
      if (event.stopData?.stopReason !== 'endTurn' || accepted !== undefined) {
        return;
      }
      end(
        cause(
          'OUTPUT_INVALID',
          lastRefusal === undefined
            ? 'the run ended without structured output'
            : `the run ended without accepted structured output; the last was refused: ${lastRefusal}`,
          { payload: textOf(event.stopData.message) },
        ),
      );
    });

    let result: AgentResult | undefined;
    let invokeError: unknown;
    try {
      result = await agent.invoke(prompt, {
        cancelSignal: environment.signal,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
    } catch (error) {
      invokeError = error;
    } finally {
      // Flushes what Strands defers, so nothing is lost with the process.
      try {
        await agent.shutdown();
      } catch (error) {
        console.error('the agent did not shut down', error);
        end(
          cause(
            'EXECUTION_ERROR',
            `the agent did not shut down, so what it defers may be lost: ${describeError(error)}`,
          ),
        );
      }
      try {
        await context.flushTelemetry?.();
      } catch (error) {
        // Telemetry is not the outcome: logged, and the run stands.
        console.error("the run's telemetry did not flush", error);
      }
    }

    const accumulated = agent.metrics.accumulatedUsage;
    const reachedModel = agent.metrics.cycleCount > 0;
    const usage: RunUsage | undefined = reachedModel
      ? {
          inputTokens: accumulated.inputTokens,
          outputTokens: accumulated.outputTokens,
          cacheReadInputTokens: accumulated.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: accumulated.cacheWriteInputTokens ?? 0,
        }
      : undefined;
    const record: RunRecord = {
      framework: { name: 'strands', fullName: STRANDS_SDK_FULL_NAME },
      promptHash,
      promptBytes: Buffer.byteLength(JSON.stringify(prompt)),
      options: recordableOptions(options, spec),
      sessionId,
      ...(context.storage === undefined
        ? {}
        : {
            transcript: {
              bucket: context.storage.bucket,
              agent: context.storage.agent,
            },
          }),
      numberOfTurns: agent.metrics.cycleCount,
      durationMilliseconds: Date.now() - startedAt,
      ...(result === undefined ? {} : { terminalReason: result.stopReason }),
      ...(usage === undefined ? {} : { usage, rawUsage: accumulated }),
    };
    environment.onRecord(record);

    if (environment.signal.aborted) throw new TaskCanceled();
    if (ended !== undefined) throw new TaskFailure(ended);
    if (invokeError !== undefined) throw new TaskFailure(classify(invokeError));
    if (result === undefined) {
      throw new TaskFailure(
        cause('EXECUTION_ERROR', 'the run ended without a result'),
      );
    }
    if (accepted === undefined) {
      throw new TaskFailure(settlementFailure(result));
    }
    if (usage === undefined) {
      throw new TaskFailure(
        cause(
          'EXECUTION_ERROR',
          'the run answered, but reports no model call and no token usage',
        ),
      );
    }
    return {
      output: accepted.value,
      sessionId,
      usage,
      rawUsage: accumulated,
      record,
    };
  } finally {
    await disconnectMcpClients(mcpClients);
  }
}

/** Why a run that ended with a result has no accepted output, from its stop reason. */
function settlementFailure(result: AgentResult): Cause {
  const reason = result.stopReason;
  if (
    reason === 'limitTurns' ||
    reason === 'limitOutputTokens' ||
    reason === 'limitTotalTokens'
  ) {
    return strandsCause('BUDGET_EXHAUSTED', `the run's ${reason} was reached`);
  }
  if (reason === 'maxTokens') {
    return strandsCause('BUDGET_EXHAUSTED', 'the model reached maxTokens');
  }
  return cause(
    'EXECUTION_ERROR',
    `the run stopped (${reason}) without structured output`,
    { payload: textOf(result.lastMessage) },
  );
}

/**
 * What the runner takes from the spec before anything runs, refusing
 * `EXECUTION_ERROR` what it cannot run: the procedure's code is wrong.
 */
function ownedByTheRunner<Output>(
  spec: AgentRunSpec<Output>,
  context: RunnerContext,
) {
  const refuse = (message: string): never => {
    throw new TaskFailure(cause('EXECUTION_ERROR', message));
  };
  const options = spec.options ?? {};
  const model =
    options.model ??
    refuse(
      "a strands run names its model: set `model` in the base layer's options or the run's",
    );
  if (
    'backgroundTasks' in options ||
    'cacheConfig' in (options.modelConfig ?? {})
  ) {
    refuse(
      "a strands run sets neither `backgroundTasks` nor `cacheConfig`: nothing runs in the background (§REQ206), and cache points come from the prompt's cache breakpoints (§REQ210)",
    );
  }
  for (const key of RUNNER_OWNED_CLIENT_KEYS) {
    if (key in (options.modelConfig ?? {})) {
      refuse(
        `a strands run's \`modelConfig\` sets no \`${key}\`: the runner owns the Anthropic client, its key (§REQ714) and the request's cancel`,
      );
    }
  }
  for (const [name, client] of Object.entries(options.mcpClients ?? {})) {
    if (client.continueOnError) {
      refuse(
        `MCP server "${name}" is set to continue on error; every MCP server must start or fail the run (§REQ201)`,
      );
    }
  }
  if (context.storage === undefined) {
    if (spec.memorySpace !== undefined) {
      refuse(
        `the run declares memory space "${spec.memorySpace}", but the deployment names no session bucket to keep it in`,
      );
    }
    if (spec.resume !== undefined) {
      refuse(
        `the run resumes session "${spec.resume}", but the deployment names no session bucket it could be kept in`,
      );
    }
    if (spec.offload !== undefined) {
      refuse(
        'the run offloads tool results, but the deployment names no session bucket to keep them in',
      );
    }
  }
  const maxAttempts =
    spec.maxStructuredOutputAttempts ?? DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    refuse(
      `maxStructuredOutputAttempts is a whole number of at least 1, not ${maxAttempts}`,
    );
  }
  const objectRoot =
    (
      z.toJSONSchema(spec.output, { io: 'input', unrepresentable: 'any' }) as {
        type?: unknown;
      }
    ).type === 'object';
  if (!objectRoot && spec.wrapNonObjectOutput !== true) {
    refuse(
      "the agent contract's root is not an object; structured output is a tool, and a tool's input must be an object. " +
        'Give the contract an object root, or pass `wrapNonObjectOutput: true` to nest it under a property on the wire.',
    );
  }
  return {
    model,
    maxAttempts,
    wire: objectRoot
      ? spec.output
      : z.strictObject({ [STRUCTURED_OUTPUT_WRAPPER_KEY]: spec.output }),
    unwrap: (input: unknown): unknown =>
      objectRoot || typeof input !== 'object' || input === null
        ? input
        : STRUCTURED_OUTPUT_WRAPPER_KEY in input
          ? (input as Record<string, unknown>)[STRUCTURED_OUTPUT_WRAPPER_KEY]
          : input,
  };
}

/** A session to resume must be one the agent's storage keeps. */
async function refuseUnknownSession(
  sessionId: string,
  storage: AgentStorage | undefined,
): Promise<void> {
  const keys = (await storage?.storage.list(sessionPrefix(sessionId))) ?? [];
  if (keys.length === 0) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `no session "${sessionId}" in the agent's storage to resume`,
      ),
    );
  }
}

/**
 * Connects every MCP server before the first turn: one that does not start
 * fails the run (§REQ201), and a cancel stops the wait.
 */
async function connectMcpClients(
  clients: Readonly<Record<string, McpClient>>,
  signal: AbortSignal,
): Promise<void> {
  for (const [name, client] of Object.entries(clients)) {
    try {
      await client.connect(false, { signal });
    } catch (error) {
      if (signal.aborted) throw new TaskCanceled();
      throw new TaskFailure(
        cause(
          'EXECUTION_ERROR',
          `MCP server "${name}" did not start: ${describeError(error)}`,
        ),
      );
    }
  }
}

/**
 * Disconnects every MCP server once the run is over, however it ended; a
 * stdio server is a child process. One that does not disconnect is logged:
 * the outcome is already settled, and the task process's exit ends it.
 */
async function disconnectMcpClients(
  clients: Readonly<Record<string, McpClient>>,
): Promise<void> {
  await Promise.all(
    Object.entries(clients).map(async ([name, client]) => {
      try {
        await client.disconnect();
      } catch (error) {
        console.error(`MCP server "${name}" did not disconnect`, error);
      }
    }),
  );
}

/** A message's text, for a cause's payload. */
function textOf(message: Message | undefined): string | undefined {
  const texts = (message?.content ?? []).flatMap((block) =>
    block.type === 'textBlock' ? [block.text] : [],
  );
  return texts.length === 0 ? undefined : texts.join('\n');
}

/** A tool list's names, where its entries have them. */
function toolNames(tools: ToolList | undefined): string[] {
  return (tools ?? []).flatMap((entry) =>
    Array.isArray(entry)
      ? toolNames(entry)
      : [(entry as { name?: unknown }).name].filter(
          (name): name is string => typeof name === 'string',
        ),
  );
}

/** The options as recorded: instances are named, prompts hashed, secrets never kept (§REQ603). */
function recordableOptions(
  options: StrandsOptions,
  spec: AgentRunSpec<unknown>,
): Record<string, unknown> {
  const names = (entries: readonly { name?: unknown }[] | undefined) =>
    entries?.map((entry) =>
      typeof entry.name === 'string' ? entry.name : entry.constructor.name,
    );
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens }),
    ...(options.modelConfig === undefined
      ? {}
      : { modelConfig: Object.keys(options.modelConfig) }),
    ...(options.systemPrompt === undefined
      ? {}
      : { systemPrompt: ohash(options.systemPrompt) }),
    ...(options.tools === undefined ? {} : { tools: toolNames(options.tools) }),
    ...(options.mcpClients === undefined
      ? {}
      : { mcpClients: Object.keys(options.mcpClients) }),
    ...(options.plugins === undefined
      ? {}
      : { plugins: names(options.plugins) }),
    ...(options.interventions === undefined
      ? {}
      : {
          interventions: names(options.interventions),
        }),
    ...(options.workingDirectories === undefined
      ? {}
      : { workingDirectories: options.workingDirectories }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(spec.memorySpace === undefined
      ? {}
      : { memorySpace: spec.memorySpace }),
    ...(spec.offload === undefined ? {} : { offload: spec.offload }),
  };
}
