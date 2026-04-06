import type {
  ToolCallResult,
  UpstreamConnection,
  UpstreamServerConfig,
} from './types.js';
import { StdioConnection } from './stdio-connection.js';
import { StreamableHttpConnection } from './streamable-http-connection.js';
import { InvalidToolNameError, UnknownUpstreamError } from './errors.js';
import type { GatewayTool } from '../filter/types.js';

/**
 * Manages multiple upstream MCP server connections.
 * Handles tool discovery, name prefixing, and routing.
 */
export class UpstreamManager {
  private servers = new Map<string, UpstreamConnection>();

  /** Connect to all configured upstreams and discover tools */
  async connectAll(
    configs: Record<string, UpstreamServerConfig>,
  ): Promise<void> {
    const entries = Object.entries(configs);
    for (const [name, config] of entries) {
      this.servers.set(name, this.createConnection(name, config));
    }

    try {
      await Promise.all(
        [...this.servers.entries()].map(async ([, conn]) => conn.connect()),
      );
    } catch (err) {
      // Clean up any successfully-connected upstreams
      await this.disconnectAll();
      throw err;
    }
  }

  /** Disconnect all upstreams */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map((conn) => conn.disconnect()),
    );
    this.servers.clear();
  }

  /** Get all tools across all upstreams, prefixed with server name */
  getAllTools(): GatewayTool[] {
    const tools: GatewayTool[] = [];
    for (const [serverName, connection] of this.servers) {
      for (const tool of connection.tools()) {
        tools.push({
          name: `${serverName}:${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }
    return tools;
  }

  /** Route a tool call to the correct upstream, stripping the server prefix */
  async callTool(
    prefixedName: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const colonIdx = prefixedName.indexOf(':');
    if (colonIdx === -1) {
      throw new InvalidToolNameError(prefixedName);
    }

    const serverName = prefixedName.slice(0, colonIdx);
    const toolName = prefixedName.slice(colonIdx + 1);

    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new UnknownUpstreamError(serverName);
    }

    return connection.callTool(toolName, args);
  }

  /** Get status of all upstreams */
  getStatus(): Record<
    string,
    {
      status: 'running' | 'stopped' | 'error';
      transport: string;
      toolCount: number;
    }
  > {
    const result: Record<
      string,
      {
        status: 'running' | 'stopped' | 'error';
        transport: string;
        toolCount: number;
      }
    > = {};
    for (const [name, connection] of this.servers) {
      result[name] = {
        status: connection.status(),
        transport:
          connection instanceof StdioConnection ? 'stdio' : 'streamable-http',
        toolCount: connection.tools().length,
      };
    }
    return result;
  }

  private createConnection(
    name: string,
    config: UpstreamServerConfig,
  ): UpstreamConnection {
    switch (config.transport) {
      case 'stdio':
        return new StdioConnection(name, config);
      case 'streamable-http':
        return new StreamableHttpConnection(name, config);
    }
  }
}
