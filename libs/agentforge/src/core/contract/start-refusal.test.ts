import { describe, expect, it } from 'vitest';
import { startRefusalErrorInfo, startRefusalOf } from './start-refusal.ts';

describe('a start refusal', () => {
  it('reads back from the ErrorInfo it is sent as', () => {
    const info = startRefusalErrorInfo('ADMISSION_LIMIT', 600);
    expect(info).toMatchObject({
      reason: 'TOO_MANY_REQUESTS',
      domain: 'agentforge',
      metadata: { refusal: 'ADMISSION_LIMIT', retryAfterSeconds: '600' },
    });
    expect(startRefusalOf([info])).toEqual({
      refusal: 'ADMISSION_LIMIT',
      retryAfterSeconds: 600,
    });
  });

  it('is absent from an error that carries no agentforge ErrorInfo', () => {
    expect(startRefusalOf(undefined)).toBeUndefined();
    expect(
      startRefusalOf([
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'INTERNAL_ERROR',
          domain: 'a2a-protocol.org',
        },
      ]),
    ).toBeUndefined();
  });

  it('throws on an agentforge ErrorInfo it cannot read, rather than miss it', () => {
    expect(() =>
      startRefusalOf([
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'TOO_MANY_REQUESTS',
          domain: 'agentforge',
          metadata: { refusal: 'SOMETHING_NEW', retryAfterSeconds: '5' },
        },
      ]),
    ).toThrow();
  });

  it('refuses a retry that is not a positive whole number of seconds', () => {
    expect(() => startRefusalErrorInfo('CONTAINER_STOPPING', 0)).toThrow();
    expect(() => startRefusalErrorInfo('CONTAINER_STOPPING', 1.5)).toThrow();
  });
});
