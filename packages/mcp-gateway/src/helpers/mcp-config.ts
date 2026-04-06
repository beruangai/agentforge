export interface McpConfigOptions {
  /** Gateway hostname (e.g., 'host.docker.internal' for Docker containers) */
  gatewayHost: string;
  /** Gateway port */
  gatewayPort: number;
  /** Tool filter patterns (e.g., ['vault:*', 'serpapi:search']) */
  tools?: string[];
  /** Use HTTPS (default: false) */
  https?: boolean;
}

/** MCP server entry for gateway connections (compatible with claude-sandbox MCPServerConfig) */
export interface GatewayMcpServerEntry {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Generates MCP server configuration for agent containers.
 * Returns a record keyed by 'gateway' ready to use as `mcpServers` in sandbox input.
 * Includes the gateway URL and tool filter header.
 */
export function mcpConfigForGateway(
  opts: McpConfigOptions,
): Record<string, GatewayMcpServerEntry> {
  const { gatewayHost, gatewayPort, tools, https = false } = opts;
  const protocol = https ? 'https' : 'http';
  const url = `${protocol}://${gatewayHost}:${gatewayPort}/mcp`;

  const entry: GatewayMcpServerEntry = { type: 'http', url };

  if (tools && tools.length > 0) {
    entry.headers = { 'X-Tools': tools.join(',') };
  }

  return { gateway: entry };
}
