export interface RateLimitConfig {
  /** Requests per minute (server-level) */
  rpm?: number;
  /** Requests per second (server-level) */
  rps?: number;
  /** Per-tool overrides (e.g., { 'search': { rpm: 10 } }) */
  tools?: Record<string, { rpm?: number; rps?: number }>;
}
