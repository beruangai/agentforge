import { describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { classifyError } from './error-classification.js';

describe('classifyError', () => {
  it('returns existing ApplicationFailure unchanged', () => {
    const original = ApplicationFailure.retryable('test', 'TestError');
    const result = classifyError(original);
    expect(result).toBe(original);
  });

  it('classifies permission denied as non-retryable', () => {
    const result = classifyError(
      new Error('Permission denied: access to resource'),
    );
    expect(result).toBeInstanceOf(ApplicationFailure);
    expect(result.type).toBe('PermissionDenied');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies unauthorized as non-retryable', () => {
    const result = classifyError(new Error('Unauthorized: invalid API key'));
    expect(result.type).toBe('PermissionDenied');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies forbidden as non-retryable', () => {
    const result = classifyError(new Error('403 Forbidden'));
    expect(result.type).toBe('PermissionDenied');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies credential errors as non-retryable', () => {
    const result = classifyError(new Error('Invalid credentials'));
    expect(result.type).toBe('PermissionDenied');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies invalid config as non-retryable', () => {
    const result = classifyError(
      new Error('Invalid configuration: missing field X'),
    );
    expect(result.type).toBe('InvalidConfiguration');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies missing required as non-retryable', () => {
    const result = classifyError(new Error('Missing required parameter'));
    expect(result.type).toBe('InvalidConfiguration');
    expect(result.nonRetryable).toBe(true);
  });

  it('classifies general errors as retryable', () => {
    const result = classifyError(new Error('Container startup failed'));
    expect(result).toBeInstanceOf(ApplicationFailure);
    expect(result.type).toBe('AgentTaskError');
    expect(result.nonRetryable).toBe(false);
  });

  it('classifies timeout errors as retryable', () => {
    const result = classifyError(new Error('Execution timed out'));
    expect(result.type).toBe('AgentTaskError');
    expect(result.nonRetryable).toBe(false);
  });

  it('classifies network errors as retryable', () => {
    const result = classifyError(new Error('ECONNREFUSED'));
    expect(result.type).toBe('AgentTaskError');
    expect(result.nonRetryable).toBe(false);
  });

  it('handles non-Error values', () => {
    const result = classifyError('string error');
    expect(result).toBeInstanceOf(ApplicationFailure);
    expect(result.type).toBe('AgentTaskError');
    expect(result.message).toContain('string error');
  });
});
