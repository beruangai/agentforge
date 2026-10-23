import {
  MaxTokensError,
  Message,
  StructuredOutputError,
  TextBlock,
} from '@strands-agents/sdk';
import { afterEach, expect, describe as group, it } from 'vitest';
import { failureOf, runScripted } from './__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  type ScriptedStep,
  scriptedAnthropic,
} from './__fixtures__/scripted-anthropic.ts';
import { classify } from './classify.ts';

let api: ScriptedAnthropic | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const RESET = '2026-10-23T12:00:00.000Z';

const refused = (
  status: number,
  type: string,
  message: string,
  extra: { details?: unknown; headers?: Record<string, string> } = {},
): ScriptedStep => ({
  status,
  error: {
    type,
    message,
    ...(extra.details === undefined ? {} : { details: extra.details }),
  },
  ...(extra.headers === undefined ? {} : { headers: extra.headers }),
});

group('classify, from what the provider answered', () => {
  it.each([
    [
      '401',
      refused(401, 'authentication_error', 'invalid x-api-key'),
      'CREDENTIAL_EXPIRED',
    ],
    [
      '403',
      refused(403, 'permission_error', 'not allowed'),
      'CREDENTIAL_EXPIRED',
    ],
    [
      'a 429 rate limit',
      refused(429, 'rate_limit_error', 'slow down'),
      'USAGE_LIMITED',
    ],
    [
      "the tier's spend cap",
      refused(429, 'rate_limit_error', 'spend cap', {
        details: { error_code: 'enforced_spend_limit_reached' },
      }),
      'BUDGET_EXHAUSTED',
    ],
    [
      "the Console's spend limit",
      refused(
        400,
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-11-01.',
      ),
      'BUDGET_EXHAUSTED',
    ],
    [
      "the Console's workspace spend limit",
      refused(
        400,
        'invalid_request_error',
        'You have reached your specified workspace API usage limits.',
      ),
      'BUDGET_EXHAUSTED',
    ],
    [
      'another invalid request',
      refused(400, 'invalid_request_error', 'messages: field required'),
      'EXECUTION_ERROR',
    ],
    ['a 500', refused(500, 'api_error', 'internal'), 'PROVIDER_TRANSIENT'],
    [
      'overloaded',
      refused(529, 'overloaded_error', 'overloaded'),
      'PROVIDER_TRANSIENT',
    ],
    [
      'the model reaching maxTokens',
      { text: 'cut', stopReason: 'max_tokens' } as const,
      'BUDGET_EXHAUSTED',
    ],
  ])('%s', async (_name, step, code) => {
    api = await scriptedAnthropic([step]);
    expect((await failureOf(runScripted(api).promise)).code).toBe(code);
  });

  it('names the spend limit, not a retry, as the action', async () => {
    api = await scriptedAnthropic([
      refused(429, 'rate_limit_error', 'spend cap', {
        details: { error_code: 'enforced_spend_limit_reached' },
      }),
    ]);
    const failure = await failureOf(runScripted(api).promise);
    expect(failure.suggestedAction).toContain('spend limit');
    expect(failure.retryAfter).toBeUndefined();
  });

  it('takes retryAfter from retry-after', async () => {
    api = await scriptedAnthropic([
      refused(429, 'rate_limit_error', 'slow down', {
        headers: { 'retry-after': '30' },
      }),
    ]);
    const before = Date.now();
    const failure = await failureOf(runScripted(api).promise);
    const after = Date.parse(failure.retryAfter ?? '');
    expect(after - before).toBeGreaterThanOrEqual(29_000);
    expect(after - before).toBeLessThan(40_000);
  });

  it('takes retryAfter from the latest rate limit reset, without retry-after', async () => {
    api = await scriptedAnthropic([
      refused(429, 'rate_limit_error', 'slow down', {
        headers: {
          'anthropic-ratelimit-requests-reset': '2026-10-23T11:00:00Z',
          'anthropic-ratelimit-tokens-reset': RESET,
        },
      }),
    ]);
    expect((await failureOf(runScripted(api).promise)).retryAfter).toBe(RESET);
  });

  it('does not retry the spend cap', async () => {
    api = await scriptedAnthropic([
      refused(429, 'rate_limit_error', 'spend cap', {
        details: { error_code: 'enforced_spend_limit_reached' },
      }),
    ]);
    const failure = await failureOf(
      runScripted(api, {}, { retryStrategy: undefined }).promise,
    );
    expect(failure.code).toBe('BUDGET_EXHAUSTED');
    expect(api.requests).toHaveLength(1);
  });
});

group('classify, from what the SDK threw', () => {
  it('a structured output Strands gave up on is OUTPUT_INVALID', () => {
    expect(classify(new StructuredOutputError('no output')).code).toBe(
      'OUTPUT_INVALID',
    );
  });

  it('maxTokens is BUDGET_EXHAUSTED', () => {
    expect(
      classify(
        new MaxTokensError(
          'cut',
          new Message({ role: 'assistant', content: [new TextBlock('cut')] }),
        ),
      ).code,
    ).toBe('BUDGET_EXHAUSTED');
  });

  it('anything else is EXECUTION_ERROR', () => {
    expect(classify(new Error('defect')).code).toBe('EXECUTION_ERROR');
  });
});
