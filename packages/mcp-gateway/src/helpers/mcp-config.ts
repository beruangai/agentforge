interface McpConfigOptions {
  /** Gateway hostname (e.g., 'host.docker.internal' for Docker containers) */
  gatewayHost: string;
  /** Gateway port */
  gatewayPort: number;
  /** Tool filter patterns (e.g., ['vault:*', 'serpapi:search']) */
  tools?: string[];
  /** Use HTTPS (default: false) */
  https?: boolean;
}

interface McpServerConfig {
  gateway: {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
  };
}

/**
 * Generates MCP server configuration for agent containers.
 * Includes the gateway URL and tool filter header.
 */
export function mcpConfigForGateway(opts: McpConfigOptions): McpServerConfig {
  const { gatewayHost, gatewayPort, tools, https = false } = opts;
  const protocol = https ? 'https' : 'http';
  const url = `${protocol}://${gatewayHost}:${gatewayPort}/mcp`;

  const config: McpServerConfig = {
    gateway: {
      type: 'http',
      url,
    },
  };

  if (tools && tools.length > 0) {
    config.gateway.headers = {
      'X-Tools': tools.join(','),
    };
  }

  return config;
}
