import { describe, it, expect, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it('allows requests when under server-level limit', async () => {
    limiter = new RateLimiter({
      search: { rps: 5 },
    });
    await limiter.acquire('search:query');
    await limiter.acquire('search:query');
    // Should not throw
  });

  it('queues requests when server-level limit reached', async () => {
    limiter = new RateLimiter({
      search: { rps: 1 },
    });
    await limiter.acquire('search:query'); // Takes the token

    let resolved = false;
    const promise = limiter.acquire('search:query').then(() => {
      resolved = true;
    });

    // Should be queued
    expect(resolved).toBe(false);

    // Cleanup
    limiter.destroy();
    await promise.catch(() => {}); // Will reject on destroy
  });

  it('applies per-tool rate limit override', async () => {
    limiter = new RateLimiter({
      search: {
        rps: 10, // server-level: 10 rps
        tools: {
          expensive: { rps: 1 }, // per-tool: 1 rps
        },
      },
    });

    await limiter.acquire('search:expensive'); // Takes tool-specific token + server token

    let resolved = false;
    const promise = limiter.acquire('search:expensive').then(() => {
      resolved = true;
    });

    // Should be queued due to tool-specific limit (1 rps), even though server has tokens
    expect(resolved).toBe(false);

    limiter.destroy();
    await promise.catch(() => {});
  });

  it('passes through when no rate limit configured for server', async () => {
    limiter = new RateLimiter({});
    // No limit configured — should pass through immediately
    for (let i = 0; i < 100; i++) {
      await limiter.acquire('unconfined:tool');
    }
  });

  it('handles tools without prefix gracefully', async () => {
    limiter = new RateLimiter({});
    await limiter.acquire('nocolon');
    // Should not throw
  });

  it('supports abort signal for queued requests', async () => {
    limiter = new RateLimiter({
      search: { rps: 1 },
    });
    await limiter.acquire('search:query'); // Drain

    const controller = new AbortController();
    const promise = limiter.acquire('search:query', controller.signal);

    controller.abort();
    await expect(promise).rejects.toThrow('Rate limit acquisition aborted');
  });

  it('destroy cleans up all buckets', () => {
    limiter = new RateLimiter({
      a: { rps: 1 },
      b: { rpm: 60 },
    });
    limiter.destroy();
    // No timer leaks
  });
});
