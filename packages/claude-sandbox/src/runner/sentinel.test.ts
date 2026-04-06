import { describe, expect, it } from 'vitest';

import { END_SENTINEL, START_SENTINEL, extractOutput } from './sentinel.js';

describe('extractOutput', () => {
  it('extracts valid output between sentinels', () => {
    const output = {
      status: 'success' as const,
      structuredOutput: { answer: 42 },
      sessionId: 'sess-123',
      metrics: {
        usage: { input_tokens: 50, output_tokens: 50 },
        durationMs: 3000,
        numTurns: 2,
      },
    };

    const stdout = `Some debug output\n${START_SENTINEL}\n${JSON.stringify(output)}\n${END_SENTINEL}\nMore stuff`;

    const result = extractOutput(stdout);
    expect(result).toEqual(output);
  });

  it('returns null when start sentinel is missing', () => {
    const stdout = `Some output\n${JSON.stringify({ status: 'success' })}\n${END_SENTINEL}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('returns null when end sentinel is missing', () => {
    const stdout = `${START_SENTINEL}\n${JSON.stringify({ status: 'success' })}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('returns null when both sentinels are missing', () => {
    expect(extractOutput('just some random output')).toBeNull();
  });

  it('returns null when end comes before start', () => {
    const stdout = `${END_SENTINEL}\nsome data\n${START_SENTINEL}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('returns null for malformed JSON between sentinels', () => {
    const stdout = `${START_SENTINEL}\n{not valid json}\n${END_SENTINEL}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('extracts output with noisy stdout before and after sentinels', () => {
    const output = { status: 'error' as const, error: 'something broke' };
    const stdout = [
      '[MCP] Server starting...',
      'DEBUG: loading tools',
      '[2024-01-01] INFO: Connected to gateway',
      START_SENTINEL,
      JSON.stringify(output),
      END_SENTINEL,
      'Cleanup complete',
      'Process exited',
    ].join('\n');

    const result = extractOutput(stdout);
    expect(result).toEqual(output);
  });

  it('extracts output with no whitespace padding', () => {
    const output = { status: 'success' as const };
    const stdout = `${START_SENTINEL}${JSON.stringify(output)}${END_SENTINEL}`;
    expect(extractOutput(stdout)).toEqual(output);
  });

  it('handles empty string', () => {
    expect(extractOutput('')).toBeNull();
  });

  it('returns null when status field is missing', () => {
    const stdout = `${START_SENTINEL}\n${JSON.stringify({ structuredOutput: 'data' })}\n${END_SENTINEL}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('returns null when status field has invalid value', () => {
    const stdout = `${START_SENTINEL}\n${JSON.stringify({ status: 'unknown' })}\n${END_SENTINEL}`;
    expect(extractOutput(stdout)).toBeNull();
  });

  it('extracts output with metrics', () => {
    const output = {
      status: 'success' as const,
      structuredOutput: { data: [1, 2, 3] },
      metrics: {
        usage: { input_tokens: 2500, output_tokens: 2500 },
        durationMs: 45000,
        numTurns: 10,
      },
    };
    const stdout = `${START_SENTINEL}\n${JSON.stringify(output)}\n${END_SENTINEL}`;
    expect(extractOutput(stdout)).toEqual(output);
  });
});
