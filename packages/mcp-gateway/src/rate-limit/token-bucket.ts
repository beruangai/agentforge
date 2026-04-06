/**
 * Token bucket with FIFO queue for rate limiting.
 * When tokens are available, acquire() resolves immediately.
 * When at capacity, acquire() blocks until a token becomes available (FIFO order).
 */
export class TokenBucket {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> =
    [];
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: { rpm?: number; rps?: number }) {
    if (config.rps) {
      this.maxTokens = config.rps;
      this.refillIntervalMs = 1000;
    } else if (config.rpm) {
      this.maxTokens = Math.max(1, Math.ceil(config.rpm / 60));
      this.refillIntervalMs = 1000;
    } else {
      this.maxTokens = Infinity;
      this.refillIntervalMs = 0;
    }

    this.tokens = this.maxTokens;

    if (this.maxTokens !== Infinity) {
      this.startRefill();
    }
  }

  /**
   * Acquire a token. Resolves immediately if available,
   * otherwise queues the request (FIFO) and resolves when a token opens up.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Rate limit acquisition aborted');
    }

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);

      signal?.addEventListener(
        'abort',
        () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error('Rate limit acquisition aborted'));
          }
        },
        { once: true },
      );
    });
  }

  /** Number of queued requests waiting for tokens */
  get pending(): number {
    return this.queue.length;
  }

  /** Current available tokens */
  get available(): number {
    return this.tokens;
  }

  /** Stop the refill timer and reject all queued requests */
  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    for (const entry of this.queue) {
      entry.reject(new Error('Token bucket destroyed'));
    }
    this.queue = [];
  }

  private startRefill(): void {
    this.refillTimer = setInterval(() => {
      this.refill();
    }, this.refillIntervalMs);
    if (
      this.refillTimer &&
      typeof this.refillTimer === 'object' &&
      'unref' in this.refillTimer
    ) {
      this.refillTimer.unref();
    }
  }

  private refill(): void {
    let tokensToAdd = this.maxTokens;

    // Serve queued requests first (FIFO)
    while (tokensToAdd > 0 && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.resolve();
      tokensToAdd--;
    }

    // Remaining tokens go back to the bucket (capped at max)
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
  }
}
