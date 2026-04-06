import type { RateLimitConfig } from './types.js';
import { TokenBucket } from './token-bucket.js';

/**
 * Unified rate limiter managing per-server and per-tool token buckets.
 * When at capacity, requests queue (FIFO) and resolve when slots open.
 */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(configs: Record<string, RateLimitConfig | undefined>) {
    for (const [server, config] of Object.entries(configs)) {
      if (!config) continue;

      // Server-level bucket
      if (config.rpm || config.rps) {
        this.buckets.set(server, new TokenBucket(config));
      }

      // Per-tool override buckets
      if (config.tools) {
        for (const [tool, toolConfig] of Object.entries(config.tools)) {
          this.buckets.set(`${server}:${tool}`, new TokenBucket(toolConfig));
        }
      }
    }
  }

  /**
   * Acquire rate limit slot(s) for a prefixed tool name.
   * Checks tool-specific limit first, then server-level.
   * If at capacity, queues (FIFO) until a slot opens.
   *
   * @param signal - AbortSignal to cancel a queued request (e.g., when client disconnects)
   */
  async acquire(prefixedToolName: string, signal?: AbortSignal): Promise<void> {
    const colonIdx = prefixedToolName.indexOf(':');
    if (colonIdx === -1) return; // No prefix = no rate limit

    const server = prefixedToolName.slice(0, colonIdx);

    // Tool-specific limit
    const toolBucket = this.buckets.get(prefixedToolName);
    if (toolBucket) {
      await toolBucket.acquire(signal);
    }

    // Server-level limit
    const serverBucket = this.buckets.get(server);
    if (serverBucket) {
      await serverBucket.acquire(signal);
    }
  }

  /** Destroy all buckets (stop timers, reject queued) */
  destroy(): void {
    for (const bucket of this.buckets.values()) {
      bucket.destroy();
    }
    this.buckets.clear();
  }
}
