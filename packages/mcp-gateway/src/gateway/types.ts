import type { UpstreamServerConfig } from '../upstream/types.js';
import type { RateLimitConfig } from '../rate-limit/types.js';
import type { GatewayMcpServerEntry } from '../helpers/mcp-config.js';

export interface GatewayConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Upstream MCP servers */
  servers: Record<string, GatewayServerConfig>;
  /** Enable request logging (default: true) */
  logging?: boolean;
  /** Hostname containers use to reach this gateway (default: 'host.docker.internal') */
  containerHost?: string;
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
  /**
   * Generate MCP server config for sandbox containers.
   * Returns config ready to pass as `mcpServers` to sandbox execution.
   * @param tools - Tool filter patterns (e.g., ['vault:*', 'serpapi:search']). Omit for all tools.
   */
  mcpServersConfig(tools?: string[]): Record<string, GatewayMcpServerEntry>;
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
