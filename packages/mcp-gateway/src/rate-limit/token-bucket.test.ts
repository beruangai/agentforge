import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TokenBucket } from './token-bucket.js';

describe('TokenBucket', () => {
  let bucket: TokenBucket;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    bucket?.destroy();
    vi.useRealTimers();
  });

  it('allows immediate acquire when tokens available', async () => {
    bucket = new TokenBucket({ rps: 3 });
    await bucket.acquire();
    expect(bucket.available).toBe(2);
  });

  it('drains all tokens', async () => {
    bucket = new TokenBucket({ rps: 2 });
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.available).toBe(0);
  });

  it('queues when no tokens available', async () => {
    bucket = new TokenBucket({ rps: 1 });
    await bucket.acquire(); // Takes the only token
    expect(bucket.available).toBe(0);

    let resolved = false;
    const promise = bucket.acquire().then(() => {
      resolved = true;
    });

    // Should be queued, not resolved
    expect(bucket.pending).toBe(1);
    expect(resolved).toBe(false);

    // Advance past refill interval (1s)
    await vi.advanceTimersByTimeAsync(1000);

    expect(resolved).toBe(true);
    await promise;
  });

  it('resolves queued requests in FIFO order', async () => {
    bucket = new TokenBucket({ rps: 1 });
    await bucket.acquire(); // Drain

    const order: number[] = [];
    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));
    const p3 = bucket.acquire().then(() => order.push(3));

    expect(bucket.pending).toBe(3);

    // Each refill tick serves 1 queued request
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1, 2, 3]);

    await Promise.all([p1, p2, p3]);
  });

  it('refills tokens after draining', async () => {
    bucket = new TokenBucket({ rps: 2 });
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.available).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(bucket.available).toBeGreaterThan(0);
  });

  it('handles RPM configuration', async () => {
    // 60 RPM = 1 per second
    bucket = new TokenBucket({ rpm: 60 });
    await bucket.acquire();
    expect(bucket.available).toBe(0);
  });

  it('handles abort signal to cancel queued request', async () => {
    bucket = new TokenBucket({ rps: 1 });
    await bucket.acquire(); // Drain

    const controller = new AbortController();
    const promise = bucket.acquire(controller.signal);
    expect(bucket.pending).toBe(1);

    controller.abort();
    await expect(promise).rejects.toThrow('Rate limit acquisition aborted');
    expect(bucket.pending).toBe(0);
  });

  it('rejects immediately if signal already aborted', async () => {
    bucket = new TokenBucket({ rps: 1 });
    await bucket.acquire(); // Drain

    const controller = new AbortController();
    controller.abort();

    await expect(bucket.acquire(controller.signal)).rejects.toThrow(
      'Rate limit acquisition aborted',
    );
    expect(bucket.pending).toBe(0);
  });

  it('destroy rejects all queued requests', async () => {
    bucket = new TokenBucket({ rps: 1 });
    await bucket.acquire(); // Drain

    const p1 = bucket.acquire();
    const p2 = bucket.acquire();

    bucket.destroy();

    await expect(p1).rejects.toThrow('Token bucket destroyed');
    await expect(p2).rejects.toThrow('Token bucket destroyed');
  });

  it('no rate limit when no config values', async () => {
    bucket = new TokenBucket({});
    for (let i = 0; i < 100; i++) {
      await bucket.acquire();
    }
    expect(bucket.pending).toBe(0);
  });
});
