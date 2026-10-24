import { inspect } from 'node:util';
import {
  MaxTokensError,
  ModelError,
  StructuredOutputError,
} from '@strands-agents/sdk';
import { type Cause, type CauseCode, cause } from '#core/contract/task.ts';
import { describeError } from '../../../server/harness/task-failure.ts';

/** The `strands` framework's own suggested actions, over the neutral ones. */
const STRANDS_SUGGESTED_ACTION_BY_CODE: Partial<Record<CauseCode, string>> = {
  BUDGET_EXHAUSTED:
    "Raise the run's `limits` or `maxTokens`, or narrow what the prompt asks for.",
  USAGE_LIMITED:
    "Retry after `retryAfter`, when the Anthropic API's rate limit resets.",
  CREDENTIAL_EXPIRED:
    "An operator replaces the Anthropic API key and updates the agent's `ANTHROPIC_API_KEY` secret; a retry cannot succeed before that (§REQ714).",
};

const SPEND_LIMIT_SUGGESTED_ACTION =
  "An operator raises the Anthropic account's spend limit in the Console; a retry cannot succeed before that (§REQ714, ADR 0022).";

/**
 * The Console's spend limit is told apart only by its message, which the API
 * documents (platform.claude.com/docs/en/api/rate-limits, 2026-10-23): the
 * operator's recorded exception to §REQ501.
 */
const SPEND_LIMIT_MESSAGE_PREFIXES = [
  'You have reached your specified API usage limits',
  'You have reached your specified workspace API usage limits',
] as const;

/** The tier's monthly spend cap, by its documented field. */
const SPEND_CAP_ERROR_CODE = 'enforced_spend_limit_reached';

/** A cause, with the `strands` framework's suggested action where it has its own. */
export function strandsCause(
  code: CauseCode,
  message: string,
  extra: Parameters<typeof cause>[2] = {},
): Cause {
  const suggestedAction = STRANDS_SUGGESTED_ACTION_BY_CODE[code];
  return cause(code, message, {
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
    ...extra,
  });
}

/** What the provider answered, read from the Anthropic SDK's error fields without importing it. */
interface ProviderError {
  readonly status?: number;
  readonly type?: string;
  readonly message?: string;
  readonly errorCode?: string;
  readonly headers?: { get(name: string): string | null };
}

/**
 * The provider's error behind what the SDK threw: the cause its model error
 * wraps — a throttled call's, or any other the provider raised — or itself.
 */
function providerError(error: unknown): ProviderError | undefined {
  const candidate =
    error instanceof ModelError && error.cause !== undefined
      ? error.cause
      : (error as unknown);
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const {
    status,
    error: body,
    headers,
  } = candidate as {
    status?: unknown;
    error?: {
      error?: {
        type?: unknown;
        message?: unknown;
        details?: { error_code?: unknown };
      };
    };
    headers?: unknown;
  };
  const detail = body?.error;
  if (typeof status !== 'number' && typeof detail?.type !== 'string') {
    return undefined;
  }
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof detail?.type === 'string' ? { type: detail.type } : {}),
    ...(typeof detail?.message === 'string' ? { message: detail.message } : {}),
    ...(typeof detail?.details?.error_code === 'string'
      ? { errorCode: detail.details.error_code }
      : {}),
    ...(isHeaders(headers) ? { headers } : {}),
  };
}

function isHeaders(
  value: unknown,
): value is { get(name: string): string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

/** Whether the provider refused for the account's spend: the Console's limit or the tier's cap. */
export function isSpendLimit(error: unknown): boolean {
  const provider = providerError(error);
  if (provider === undefined) return false;
  if (provider.status === 429 && provider.errorCode === SPEND_CAP_ERROR_CODE) {
    return true;
  }
  return (
    provider.status === 400 &&
    provider.type === 'invalid_request_error' &&
    SPEND_LIMIT_MESSAGE_PREFIXES.some(
      (prefix) => provider.message?.startsWith(prefix) === true,
    )
  );
}

/** When a rate limit resets: `retry-after`, else the latest reset the API reports. */
function retryAfter(provider: ProviderError): string | undefined {
  const headers = provider.headers;
  if (headers === undefined) return undefined;
  const seconds = Number(headers.get('retry-after'));
  if (headers.get('retry-after') !== null && Number.isFinite(seconds)) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const resets = [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
  ]
    .map((name) => headers.get(name))
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter((time) => Number.isFinite(time));
  return resets.length === 0
    ? undefined
    : new Date(Math.max(...resets)).toISOString();
}

/** A run's failure, classified from the error's fields, never its text but for the documented spend limit (§REQ501). */
export function classify(error: unknown): Cause {
  const message = describeError(error);
  const stackTrace = inspect(error, { depth: 8 });
  if (error instanceof StructuredOutputError) {
    return cause('OUTPUT_INVALID', message, { stackTrace });
  }
  if (error instanceof MaxTokensError) {
    return strandsCause('BUDGET_EXHAUSTED', 'the model reached maxTokens', {
      stackTrace,
    });
  }
  if (isSpendLimit(error)) {
    return cause('BUDGET_EXHAUSTED', message, {
      suggestedAction: SPEND_LIMIT_SUGGESTED_ACTION,
      stackTrace,
    });
  }
  const provider = providerError(error);
  const status = provider?.status;
  if (status === 401 || status === 403) {
    return strandsCause('CREDENTIAL_EXPIRED', message, { stackTrace });
  }
  if (status === 429 && provider !== undefined) {
    const after = retryAfter(provider);
    return strandsCause('USAGE_LIMITED', message, {
      stackTrace,
      ...(after === undefined ? {} : { retryAfter: after }),
    });
  }
  if (
    (typeof status === 'number' && status >= 500) ||
    provider?.type === 'overloaded_error' ||
    isConnectionError(error)
  ) {
    return cause('PROVIDER_TRANSIENT', message, { stackTrace });
  }
  return cause('EXECUTION_ERROR', message, { stackTrace });
}

/**
 * The Anthropic SDK's connection errors, a timeout among them, carry no
 * status and the generic name `Error`; their class is the one field that
 * names them, read without importing the SDK.
 */
const CONNECTION_ERROR_CLASSES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

function isConnectionError(error: unknown): boolean {
  const candidate = error instanceof ModelError ? error.cause : error;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    CONNECTION_ERROR_CLASSES.has(candidate.constructor.name)
  );
}
