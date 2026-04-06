import type { UpstreamServerConfig } from '../upstream/types.js';
import type { RateLimitConfig } from '../rate-limit/types.js';

export interface GatewayConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Upstream MCP servers */
  servers: Record<string, GatewayServerConfig>;
  /** Enable request logging (default: true) */
  logging?: boolean;
}

export type GatewayServerConfig = UpstreamServerConfig & {
  /** Rate limit for this server (applied across all agents) */
  rateLimit?: RateLimitConfig;
};

export interface Gateway {
  /** Graceful shutdown */
  close(): Promise<void>;
  /** Current server status */
  status(): GatewayStatus;
}

export interface GatewayStatus {
  port: number;
  upstreams: Record<
    string,
    {
      status: 'running' | 'stopped' | 'error';
      transport: string;
      toolCount: number;
    }
  >;
}
