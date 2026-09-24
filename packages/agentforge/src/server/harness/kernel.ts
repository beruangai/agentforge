import { setTimeout as delay } from 'node:timers/promises';
import {
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type Cause, cause, type RunRecord } from '#core/contract/task.ts';

/** The SDK options a procedure may set; the kernel owns the rest. */
export type AgentOptions = Omit<Options, 'outputFormat' | 'abortController'>;

export type AgentPrompt = string | SDKUserMessage['message']['content'];

export interface AgentRunSpec<Output> {
  /** What the agent is asked. Content blocks for anything beyond text. */
  readonly prompt: AgentPrompt;
  /** The agent contract: what the agent itself fills in (§REQ102). */
  readonly output: z.ZodType<Output>;
  readonly options?: AgentOptions;
}

export interface AgentRun<Output> {
  readonly output: Output;
  readonly sessionId: string;
  readonly record: RunRecord;
}

/** A run that ended on its own terms without an answer: the task fails with this cause. */
export class TaskFailure extends Error {
  constructor(readonly taskCause: Cause) {
    super(`${taskCause.code}: ${taskCause.message}`);
    this.name = 'TaskFailure';
  }
}

/** The run was cancelled; the task ends `TASK_STATE_CANCELED`. */
export class TaskCanceled extends Error {
  constructor() {
    super('the task was cancelled');
    this.name = 'TaskCanceled';
  }
}

export interface KernelContext {
  readonly signal: AbortSignal;
  readonly onRecord: (record: RunRecord) => void;
}

export type QueryFunction = typeof sdkQuery;

/** How long the process may keep running after its input ends. */
const drainBoundMilliseconds = 30_000;
/** How long an interrupt has to settle before the run is aborted outright. */
const interruptGraceMilliseconds = 3_000;

/**
 * One `query()` to a settled, typed outcome (ARCHITECTURE.md §7).
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
  const startedAt = Date.now();
  const abortController = new AbortController();
  const { promise: inputEnded, resolve: endInput } =
    Promise.withResolvers<void>();

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: spec.prompt },
      parent_tool_use_id: null,
    };
    await inputEnded;
  }

  const options: Options = {
    ...spec.options,
    env: {
      ...process.env,
      ...spec.options?.env,
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    outputFormat: {
      type: 'json_schema',
      schema: z.toJSONSchema(spec.output, { target: 'draft-7' }),
    },
    abortController,
  };
  const session = query({ prompt: prompt(), options });

  let canceled = false;
  const onAbort = (): void => {
    canceled = true;
    void session.interrupt().catch(() => undefined);
    setTimeout(
      () => abortController.abort(),
      interruptGraceMilliseconds,
    ).unref();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });

  const observed: Observed = {
    sessionId: undefined,
    rateLimitResetsAt: undefined,
    assistantError: undefined,
    mirrorError: undefined,
  };
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
      if (next.value.type === 'result' && result === undefined) {
        result = next.value;
        drainDeadline = Date.now() + drainBoundMilliseconds;
        endInput();
      }
    }
  } catch (error) {
    // The turn and budget limits end with a result and only then throw; an
    // error after the first result changes nothing. One with no result is
    // how a crash, a lost connection or an abort ends.
    if (result === undefined) streamError = error;
  } finally {
    endInput();
    context.signal.removeEventListener('abort', onAbort);
  }

  const record: RunRecord = {
    prompt: spec.prompt,
    options: recordableOptions(spec.options),
    ...(observed.sessionId === undefined
      ? {}
      : { sessionId: observed.sessionId }),
    durationMilliseconds: Date.now() - startedAt,
    ...(result === undefined
      ? {}
      : {
          numberOfTurns: result.num_turns,
          totalCostUsd: result.total_cost_usd,
          modelUsage: result.modelUsage,
          ...(result.terminal_reason === undefined
            ? {}
            : { terminalReason: result.terminal_reason }),
        }),
  };
  context.onRecord(record);

  if (canceled) throw new TaskCanceled();
  if (observed.mirrorError !== undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `the session transcript could not be mirrored: ${observed.mirrorError}`,
      ),
    );
  }
  if (result === undefined) {
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `the run ended without a result: ${describe(streamError)}`,
      ),
    );
  }
  const sessionId = observed.sessionId ?? result.session_id;
  return { output: settle(result, spec.output, observed), sessionId, record };
}

interface Observed {
  sessionId: string | undefined;
  rateLimitResetsAt: number | undefined;
  assistantError: string | undefined;
  mirrorError: string | undefined;
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
  if (message.type === 'assistant' && message.error !== undefined) {
    observed.assistantError = message.error;
  }
  if (message.type === 'system' && message.subtype === 'mirror_error') {
    observed.mirrorError = JSON.stringify(message);
  }
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

const credentialErrors = new Set([
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
  observed: Pick<Observed, 'rateLimitResetsAt' | 'assistantError'>,
): Output {
  if (result.subtype === 'success' && !result.is_error) {
    if (
      result.structured_output === undefined ||
      result.structured_output === null
    ) {
      throw new TaskFailure(
        cause('OUTPUT_INVALID', 'the run ended without a structured answer', {
          payload: result.result,
        }),
      );
    }
    const parsed = schema.safeParse(result.structured_output);
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
    throw new TaskFailure(cause('BUDGET_EXHAUSTED', 'maxTurns was reached'));
  }
  if (result.subtype === 'error_max_budget_usd') {
    throw new TaskFailure(
      cause('BUDGET_EXHAUSTED', 'maxBudgetUsd was reached'),
    );
  }
  if (result.subtype === 'error_max_structured_output_retries') {
    throw new TaskFailure(
      cause(
        'OUTPUT_INVALID',
        'the agent could not produce a conforming answer',
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
    (assistantError !== undefined && credentialErrors.has(assistantError)) ||
    status === 401 ||
    status === 403
  ) {
    throw new TaskFailure(cause('CREDENTIAL_EXPIRED', message));
  }
  if (
    assistantError === 'rate_limit' ||
    assistantError === 'billing_error' ||
    status === 429
  ) {
    const resetsAt = observed.rateLimitResetsAt;
    throw new TaskFailure(
      cause(
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

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
