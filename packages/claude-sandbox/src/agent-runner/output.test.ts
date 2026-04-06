import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emitError, emitOutput, emitSuccess } from './output.js';
import { extractOutput } from '../runner/sentinel.js';

describe('agent-runner output helpers', () => {
  let written: string;

  beforeEach(() => {
    written = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        written += chunk.toString();
        return true;
      },
    );
  });

  it('emitOutput wraps output in sentinels', () => {
    const output = {
      status: 'success' as const,
      structuredOutput: { answer: 42 },
    };
    emitOutput(output);

    // The sentinel-wrapped output should be extractable
    const extracted = extractOutput(written);
    expect(extracted).toEqual(output);
  });

  it('emitSuccess emits success status', () => {
    emitSuccess({
      structuredOutput: { data: 'test' },
      sessionId: 'sess-1',
      metrics: {
        usage: { input_tokens: 50, output_tokens: 50 },
        durationMs: 3000,
        numTurns: 2,
      },
    });

    const extracted = extractOutput(written);
    expect(extracted?.status).toBe('success');
    expect(extracted?.structuredOutput).toEqual({ data: 'test' });
    expect(extracted?.sessionId).toBe('sess-1');
    expect(extracted?.metrics).toEqual({
      usage: { input_tokens: 50, output_tokens: 50 },
      durationMs: 3000,
      numTurns: 2,
    });
  });

  it('emitError emits error status with message', () => {
    emitError(new Error('something went wrong'));

    const extracted = extractOutput(written);
    expect(extracted?.status).toBe('error');
    expect(extracted?.error).toBe('something went wrong');
  });

  it('emitError handles non-Error objects', () => {
    emitError('string error');

    const extracted = extractOutput(written);
    expect(extracted?.status).toBe('error');
    expect(extracted?.error).toBe('string error');
  });
});
