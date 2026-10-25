import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import {
  type ModelUsage,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SessionStore,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { hash as ohash } from 'ohash';
import { z } from 'zod';
import {
  type CauseCode,
  cause,
  type RunRecord,
  type RunUsage,
  type TranscriptLocation,
} from '#core/contract/task.ts';
import {
  type RunEnvironment,
  refuseUnknownRunSpecFields,
  type AgentRun as SharedAgentRun,
  type AgentRunSpec as SharedAgentRunSpec,
  type TaskContext as SharedTaskContext,
} from '../../../server/harness/framework.ts';
import {
  describeError,
  TaskCanceled,
  TaskFailure,
} from '../../../server/harness/task-failure.ts';
import { S3SessionStore } from '../core/s3-session-store.ts';
import { CLAUDE_AGENT_SDK_FULL_NAME } from '../core/sdk-version.ts';
import { autoMemoryOptions } from './auto-memory.ts';
import { subscriptionEnv } from './credentials.ts';
import {
  type CommandBlock,
  type ContentBlock,
  createStreamingInput,
  createUserMessage,
} from './prompt.ts';
import { withFreshSdkServers } from './sdk-mcp-servers.ts';
import {
  structuredOutputWireSchema,
  unwrapStructuredOutput,
} from './structured-output.ts';
import { structuredOutputValidation } from './structured-output-validation.ts';
import { composeSystemPrompt } from './system-prompt.ts';
import { spawnWithUserScope, userConfigDirectory } from './user-scope.ts';

/** The SDK options a procedure may set; the kernel owns the rest. */
export type AgentOptions = Omit<Options, 'outputFormat' | 'abortController'>;

/** What the `claude` framework fixes for its procedures' types. */
export type ClaudeTypes = {
  readonly content: ContentBlock | CommandBlock;
  readonly options: AgentOptions;
  readonly extras: {
    /**
     * An absolute directory to keep Claude Code's auto memory in, usually a
     * mounted filesystem's `localPath`, one memory space: its `MEMORY.md` index
     * is in context from the first turn, and the agent is told how to keep it
     * (§REQ404). Without it, auto memory is off.
     */
    readonly memoryDirectory?: string;
  };
  /** The SDK's usage per model. */
  readonly usage: Readonly<Record<string, ModelUsage>>;
};

/** The spec fields `claude` takes beside the shared ones. */
const CLAUDE_RUN_SPEC_EXTRAS: Record<keyof ClaudeTypes['extras'], true> = {
  memoryDirectory: true,
};

export type AgentRunSpec<Output> = SharedAgentRunSpec<ClaudeTypes, Output>;

export type AgentRun<Output> = SharedAgentRun<ClaudeTypes, Output>;

/**
 * What every `claude` procedure handler receives as its oRPC context. An
 * interface rather than an alias, so a procedure module's inferred router
 * type names it from `/claude/agent`.
 */
export interface TaskContext extends SharedTaskContext<ClaudeTypes> {}

export interface KernelContext extends RunEnvironment {
  /** The store the deployment declares; a procedure's own `sessionStore` wins. */
  readonly sessionStore?: SessionStore;
}

export type QueryFunction = typeof sdkQuery;

/** What the kernel sets in every run's `env`, over the procedure's: background work off. */
export const BACKGROUND_WORK_DISABLED = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
} as const;

/** How long the process may keep running after its input ends. */
const DRAIN_BOUND_MILLISECONDS = 30_000;
/** How long an interrupt has to settle before the run is aborted outright. */
const INTERRUPT_GRACE_MILLISECONDS = 3_000;

/**
 * One `query()` to a settled, typed outcome (ARCHITECTURE.md §6).
 *
 * Streaming input, so `interrupt()` is reachable; background work off, so a
 * finishing background task cannot publish a second answer; the first result
 * is the outcome, and the stream is then drained to process exit under a
 * bound. The outcome is classified from the result's fields, never from an
 * error's text.
 */
export async function runAgent<Output>(
  spec: AgentRunSpec<Output>,
  context: KernelContext,
  query: QueryFunction = sdkQuery,
): Promise<AgentRun<Output>> {
  if (context.signal.aborted) throw new TaskCanceled();
  refuseUnknownRunSpecFields(spec, {
    name: 'claude',
    extras: CLAUDE_RUN_SPEC_EXTRAS,
  });
  const startedAt = Date.now();
  const { systemPrompt, memory } = ownedByTheKernel(spec);
  const ownedOptions: AgentOptions = {
    ...spec.options,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(memory.settings === undefined ? {} : { settings: memory.settings }),
  };
  const wire = structuredOutputWireSchema(spec.output, {
    wrapNonObjectOutput: spec.wrapNonObjectOutput ?? false,
  });
  const message = await createUserMessage(
    spec.prompt,
    spec.options?.cwd ?? process.cwd(),
  );
  // A cancel while the prompt's documents were read: the listener below
  // would never hear an abort that already happened.
  if (context.signal.aborted) throw new TaskCanceled();
  const promptHash = ohash(message.message.content);
  // The prompt as sent, whole, in the container log (§REQ601); the record
  // carries its hash.
  console.log(
    JSON.stringify({
      event: 'agentforge.prompt',
      promptHash,
      prompt: message.message.content,
      systemPrompt,
    }),
  );
  const abortController = new AbortController();
  const { promise: inputEnded, resolve: endInput } =
    Promise.withResolvers<void>();

  const observed: Observed = {
    sessionId: undefined,
    rateLimitResetsAt: undefined,
    assistantError: undefined,
    mirrorError: undefined,
    assistantMessages: [],
    deadMatchers: [],
    lastRefusal: undefined,
  };

  // A guard that throws ends the run: a defect, never told to the agent.
  let guardError: { readonly error: unknown } | undefined;
  const validationHook = structuredOutputValidation({
    output: spec.output,
    wrapped: wire.wrapped,
    guards: spec.guardrails?.stop ?? [],
    onRefused: (reason) => {
      observed.lastRefusal = reason;
    },
    onGuardError: (error) => {
      guardError ??= { error };
      abortController.abort();
    },
  });

  const declaredStore = spec.options?.sessionStore ?? context.sessionStore;
  const mirror =
    declaredStore === undefined ? undefined : recordingStore(declaredStore);
  const mcpServers = withFreshSdkServers(ownedOptions.mcpServers);
  const env = { ...memory.env, ...BACKGROUND_WORK_DISABLED };
  // The SDK drops the CLI's stderr unless asked for it, and with it the
  // CLI's telemetry export errors; into the task's log instead.
  const stderr =
    spec.options?.stderr ??
    ((data: string) => {
      process.stderr.write(data);
    });
  // A resume from the store runs in a config directory of the SDK's, which
  // is given the user scope a fresh run has (§REQ201, §REQ402).
  const resumesFromStore =
    mirror !== undefined &&
    (ownedOptions.resume !== undefined || ownedOptions.continue === true);
  const options: Options = {
    ...ownedOptions,
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(mirror === undefined ? {} : { sessionStore: mirror.store }),
    ...(resumesFromStore
      ? {
          spawnClaudeCodeProcess: spawnWithUserScope(userConfigDirectory(env), {
            spawnClaudeCodeProcess: ownedOptions.spawnClaudeCodeProcess,
            stderr,
          }),
        }
      : {}),
    env,
    // The kernel's structured output validation after the procedure's own hooks (§REQ204).
    hooks: {
      ...spec.options?.hooks,
      PreToolUse: [...(spec.options?.hooks?.PreToolUse ?? []), validationHook],
    },
    outputFormat: { type: 'json_schema', schema: wire.schema },
    abortController,
    stderr,
  };
  const session = query({
    prompt: createStreamingInput(message, inputEnded),
    options,
  });

  let canceled = false;
  const onAbort = (): void => {
    canceled = true;
    void session.interrupt().catch((error: unknown) => {
      // The abort after the grace period still ends the run.
      console.error('the run could not be interrupted', error);
    });
    setTimeout(
      () => abortController.abort(),
      INTERRUPT_GRACE_MILLISECONDS,
    ).unref();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });

  let result: SDKResultMessage | undefined;
  let drainDeadline: number | undefined;
  let streamError: unknown;
  const iterator = session[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextBefore(iterator, drainDeadline);
      if (next === 'timed-out') {
        session.close();
        break;
      }
      if (next.done) break;
      observe(next.value, observed);
      if (next.value.type === 'system' && next.value.subtype === 'init') {
        observed.deadMatchers = deadToolMatchers(
          spec.options?.hooks,
          next.value.tools,
        );
        if (observed.deadMatchers.length > 0) {
          // Before the first turn: no tool may run with a guardrail missing.
          abortController.abort();
          break;
        }
      }
      if (next.value.type === 'result') {
        if (result === undefined) {
          result = next.value;
          drainDeadline = Date.now() + DRAIN_BOUND_MILLISECONDS;
          endInput();
        } else {
          console.error(
            'a result after the first is not the outcome, and is ignored',
            next.value,
          );
        }
      }
    }
  } catch (error) {
    // Whatever threw — the stream, or the kernel's own code — the process may
    // still be running a turn no one is observing.
    session.close();
    // The turn and budget limits end with a result and only then throw; an
    // error after the first result changes nothing. One with no result is
    // how a crash, a lost connection or an abort ends.
    if (result === undefined) {
      streamError = error;
    } else {
      console.error('the run threw after its first result', error);
    }
  } finally {
    endInput();
    context.signal.removeEventListener('abort', onAbort);
  }

  const usage = result === undefined ? undefined : usageOf(result);
  const record: RunRecord = {
    framework: { name: 'claude', fullName: CLAUDE_AGENT_SDK_FULL_NAME },
    promptHash,
    promptBytes: Buffer.byteLength(JSON.stringify(message.message.content)),
    options: recordableOptions(ownedOptions),
    ...(observed.sessionId === undefined
      ? {}
      : { sessionId: observed.sessionId }),
    ...transcriptOf(
      spec.options?.sessionStore === undefined
        ? context.sessionStore
        : undefined,
      mirror?.projectKeys,
      observed.sessionId,
    ),
    durationMilliseconds: Date.now() - startedAt,
    ...(result === undefined
      ? {}
      : {
          numberOfTurns: result.num_turns,
          ...(usage === undefined ? {} : { usage }),
          rawUsage: result.modelUsage,
          totalCostUsd: result.total_cost_usd,
          ...(result.terminal_reason === undefined
            ? {}
            : { terminalReason: result.terminal_reason }),
        }),
  };
  context.onRecord(record);

  if (canceled) throw new TaskCanceled();
  if (guardError !== undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `a stop guard threw while the structured output was validated: ${describeError(guardError.error)}`,
        { stackTrace: inspect(guardError.error, { depth: 8 }) },
      ),
    );
  }
  if (observed.deadMatchers.length > 0) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `hook matchers that match no tool this session has, and would never fire: ${observed.deadMatchers.join('; ')}`,
        {
          suggestedAction:
            'Make each matcher name a tool the session has: check the tool names in `allowedTools`, `mcp__<server>__<tool>` for an MCP tool, and the matcher syntax — letters, digits, `_`, `-`, spaces, `,` and `|` are an exact list; anything else is a regular expression.',
        },
      ),
    );
  }
  // Before the mirror's checks: a run that ended without a result did not
  // mirror whole either, and why it ended is the failure to report.
  if (result === undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `the run ended without a result: ${describeError(streamError)}${
          observed.mirrorError === undefined
            ? ''
            : `; and the session transcript could not be mirrored: ${observed.mirrorError}`
        }`,
        streamError === undefined
          ? {}
          : { stackTrace: inspect(streamError, { depth: 8 }) },
      ),
    );
  }
  if (observed.mirrorError !== undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `the session transcript could not be mirrored: ${observed.mirrorError}`,
      ),
    );
  }
  if (mirror !== undefined) {
    const unmirrored = observed.assistantMessages.filter(
      (uuid) => !mirror.mirrored.has(uuid),
    );
    if (unmirrored.length > 0) {
      throw new TaskFailure(
        cause(
          'EXECUTION_ERROR',
          `the session store holds no entry for ${unmirrored.length} of the run's ${observed.assistantMessages.length} assistant messages: the transcript would not resume whole`,
        ),
      );
    }
  }
  const sessionId = observed.sessionId ?? result.session_id;
  const output = settle(result, spec.output, observed, wire.wrapped);
  if (usage === undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        'the run answered, but its result reports no token usage',
      ),
    );
  }
  return { output, sessionId, usage, rawUsage: result.modelUsage, record };
}

/** The result's token usage in the shared terms; none where the result reports none. */
function usageOf(result: SDKResultMessage): RunUsage | undefined {
  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  } = result.usage ?? {};
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof cacheReadInputTokens !== 'number' ||
    typeof cacheCreationInputTokens !== 'number'
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

interface Observed {
  sessionId: string | undefined;
  rateLimitResetsAt: number | undefined;
  assistantError: SDKAssistantMessageError | undefined;
  mirrorError: string | undefined;
  /** Every assistant message's uuid, which the transcript entry for it shares. */
  assistantMessages: string[];
  deadMatchers: string[];
  /** Why the agent's last submitted structured output was refused, if it was. */
  lastRefusal: string | undefined;
}

/** The hook events whose matcher is tested against a tool name. */
const TOOL_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
] as const;

/** Only these characters, and a matcher is a list of exact names. */
const EXACT_MATCHER_PATTERN = /^[A-Za-z0-9_\- ,|]*$/;

/**
 * Whether a hook matcher selects a tool, as Claude Code evaluates it: `*`,
 * empty or omitted matches everything; a matcher of word characters, `-`,
 * spaces, `,` and `|` is a list of exact names; anything else is an
 * unanchored JavaScript regular expression.
 */
export function matcherSelects(
  matcher: string | undefined,
  tool: string,
): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (EXACT_MATCHER_PATTERN.test(matcher)) {
    return matcher.split(/[|,]/).some((name) => name.trim() === tool);
  }
  return new RegExp(matcher).test(tool);
}

/**
 * Tool-event matchers that select none of the session's tools. Such a hook
 * fires zero times and reports nothing — a guardrail that looks exactly like
 * a passing run — so the run fails instead.
 */
export function deadToolMatchers(
  hooks: Options['hooks'],
  tools: readonly string[],
): string[] {
  return TOOL_HOOK_EVENTS.flatMap((event) =>
    (hooks?.[event] ?? [])
      .filter(
        (entry) => !tools.some((tool) => matcherSelects(entry.matcher, tool)),
      )
      .map((entry) => `${event} "${entry.matcher}"`),
  );
}

function observe(message: SDKMessage, observed: Observed): void {
  if ('session_id' in message && typeof message.session_id === 'string') {
    observed.sessionId ??= message.session_id;
  }
  if (message.type === 'rate_limit_event') {
    const { status, resetsAt } = message.rate_limit_info;
    if (status === 'rejected' && resetsAt !== undefined) {
      observed.rateLimitResetsAt = resetsAt;
    }
  }
  if (message.type === 'assistant') {
    observed.assistantMessages.push(message.uuid);
    if (message.error !== undefined) observed.assistantError = message.error;
  }
  if (message.type === 'system' && message.subtype === 'mirror_error') {
    observed.mirrorError = JSON.stringify(message);
  }
}

/**
 * The store as the SDK sees it, noting each entry it accepted. The SDK's
 * mirror is best-effort, so the kernel checks what landed rather than
 * trusting it (ADR 0011).
 */
function recordingStore(store: SessionStore): {
  store: SessionStore;
  mirrored: Set<string>;
  /** Each session's project key, as its main transcript was appended under it. */
  projectKeys: Map<string, string>;
} {
  const mirrored = new Set<string>();
  const projectKeys = new Map<string, string>();
  return {
    mirrored,
    projectKeys,
    store: {
      append: async (key, entries) => {
        await store.append(key, entries);
        if (key.subpath === undefined) {
          projectKeys.set(key.sessionId, key.projectKey);
        }
        for (const entry of entries) {
          const uuid = (entry as { uuid?: unknown }).uuid;
          if (typeof uuid === 'string') mirrored.add(uuid);
        }
      },
      load: (key) => store.load(key),
      ...(store.listSessions && {
        listSessions: store.listSessions.bind(store),
      }),
      ...(store.listSessionSummaries && {
        listSessionSummaries: store.listSessionSummaries.bind(store),
      }),
      ...(store.delete && { delete: store.delete.bind(store) }),
      ...(store.listSubkeys && { listSubkeys: store.listSubkeys.bind(store) }),
    },
  };
}

/**
 * Where the run's transcript is, when the deployment's store kept it — a
 * procedure's own store is its to locate.
 */
function transcriptOf(
  deploymentStore: SessionStore | undefined,
  projectKeys: ReadonlyMap<string, string> | undefined,
  sessionId: string | undefined,
): { transcript?: TranscriptLocation } {
  if (!(deploymentStore instanceof S3SessionStore) || sessionId === undefined)
    return {};
  const projectKey = projectKeys?.get(sessionId);
  return projectKey === undefined
    ? {}
    : { transcript: deploymentStore.location({ projectKey, sessionId }) };
}

/** The next message, or `'timed-out'` once a deadline has passed. */
async function nextBefore(
  iterator: AsyncIterator<SDKMessage>,
  deadline: number | undefined,
): Promise<IteratorResult<SDKMessage> | 'timed-out'> {
  if (deadline === undefined) return iterator.next();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'timed-out';
  const timer = new AbortController();
  try {
    return await Promise.race([
      iterator.next(),
      delay(remaining, 'timed-out' as const, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}

/** The `claude` framework's own suggested actions, over the neutral ones. */
const CLAUDE_SUGGESTED_ACTION_BY_CODE: Partial<Record<CauseCode, string>> = {
  BUDGET_EXHAUSTED:
    'Raise `maxTurns` or `maxBudgetUsd` for the procedure, or narrow what the prompt asks for.',
  USAGE_LIMITED:
    "Retry after `retryAfter`, when the subscription's usage limit resets.",
  CREDENTIAL_EXPIRED:
    "An operator renews the subscription token (`claude setup-token`) and updates the agent's secret; a retry cannot succeed before that (§REQ714).",
};

/** A cause, with the `claude` framework's suggested action where it has its own. */
function claudeCause(
  code: CauseCode,
  message: string,
  extra: Parameters<typeof cause>[2] = {},
) {
  const suggestedAction = CLAUDE_SUGGESTED_ACTION_BY_CODE[code];
  return cause(code, message, {
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
    ...extra,
  });
}

const CREDENTIAL_ERRORS = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]);

/** The outcome, read from the result's own fields. */
export function settle<Output>(
  result: SDKResultMessage,
  schema: z.ZodType<Output>,
  observed: Pick<
    Observed,
    'rateLimitResetsAt' | 'assistantError' | 'lastRefusal'
  >,
  wrapped = false,
): Output {
  if (result.subtype === 'success' && !result.is_error) {
    if (
      result.structured_output === undefined ||
      result.structured_output === null
    ) {
      // An agent may give up after a refusal rather than submit again.
      throw new TaskFailure(
        cause(
          'OUTPUT_INVALID',
          observed.lastRefusal === undefined
            ? 'the run ended without structured output'
            : `the run ended without accepted structured output; the last was refused: ${observed.lastRefusal}`,
          { payload: result.result },
        ),
      );
    }
    const parsed = schema.safeParse(
      unwrapStructuredOutput(result.structured_output, wrapped),
    );
    if (!parsed.success) {
      throw new TaskFailure(
        cause('OUTPUT_INVALID', z.prettifyError(parsed.error), {
          payload: result.structured_output,
        }),
      );
    }
    return parsed.data;
  }
  if (result.subtype === 'error_max_turns') {
    throw new TaskFailure(
      claudeCause('BUDGET_EXHAUSTED', 'maxTurns was reached'),
    );
  }
  if (result.subtype === 'error_max_budget_usd') {
    throw new TaskFailure(
      claudeCause('BUDGET_EXHAUSTED', 'maxBudgetUsd was reached'),
    );
  }
  if (result.subtype === 'error_max_structured_output_retries') {
    // The CLI's message carries the last refusal: the contract's error or a
    // stop guard's reasons.
    throw new TaskFailure(
      cause(
        'OUTPUT_INVALID',
        `the agent could not produce accepted structured output: ${result.errors.join('; ') || result.subtype}`,
      ),
    );
  }
  const status =
    'api_error_status' in result ? result.api_error_status : undefined;
  const message =
    result.subtype === 'success'
      ? result.result
      : result.errors.join('; ') || result.subtype;
  const assistantError = observed.assistantError;
  if (
    (assistantError !== undefined && CREDENTIAL_ERRORS.has(assistantError)) ||
    status === 401 ||
    status === 403
  ) {
    throw new TaskFailure(claudeCause('CREDENTIAL_EXPIRED', message));
  }
  if (
    assistantError === 'rate_limit' ||
    assistantError === 'billing_error' ||
    status === 429
  ) {
    const resetsAt = observed.rateLimitResetsAt;
    throw new TaskFailure(
      claudeCause(
        'USAGE_LIMITED',
        message,
        resetsAt === undefined
          ? {}
          : { retryAfter: new Date(resetsAt * 1000).toISOString() },
      ),
    );
  }
  if (
    assistantError === 'overloaded' ||
    assistantError === 'server_error' ||
    (typeof status === 'number' && status >= 500)
  ) {
    throw new TaskFailure(cause('PROVIDER_TRANSIENT', message));
  }
  throw new TaskFailure(cause('EXECUTION_ERROR', message));
}

/**
 * What the kernel adds to the procedure's options from what the run declares
 * — the system-prompt fragments it calls for, and its auto memory — refused
 * `EXECUTION_ERROR` before anything runs: the procedure's code is wrong.
 */
function ownedByTheKernel(spec: AgentRunSpec<unknown>) {
  try {
    return {
      systemPrompt: composeSystemPrompt(spec),
      memory: autoMemoryOptions(
        spec,
        subscriptionEnv(process.env, spec.options?.env),
      ),
    };
  } catch (error) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/** The options as recorded: values that are functions or secrets are named, not kept (§REQ603). */
function recordableOptions(
  options: AgentOptions | undefined,
): Record<string, unknown> {
  if (options === undefined) return {};
  const recorded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'env') {
      recorded.env = Object.keys(value ?? {});
    } else if (key === 'hooks') {
      recorded.hooks = Object.fromEntries(
        Object.entries(value ?? {}).map(([event, matchers]) => [
          event,
          (matchers as { matcher?: string }[]).map(
            (matcher) => matcher.matcher ?? '*',
          ),
        ]),
      );
    } else if (key === 'systemPrompt') {
      recorded.systemPrompt = ohash(value);
    } else if (key === 'mcpServers') {
      recorded.mcpServers = Object.keys(value ?? {});
    } else if (
      key === 'sessionStore' ||
      key === 'canUseTool' ||
      key === 'stderr'
    ) {
      recorded[key] = value === undefined ? undefined : true;
    } else if (typeof value !== 'function') {
      recorded[key] = value;
    }
  }
  return recorded;
}
