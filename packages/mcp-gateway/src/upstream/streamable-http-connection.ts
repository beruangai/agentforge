import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  StreamableHttpServerConfig,
  ToolCallResult,
  UpstreamConnection,
} from './types.js';
import { UpstreamNotRunningError } from './errors.js';

export class StreamableHttpConnection implements UpstreamConnection {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private discoveredTools: Tool[] = [];
  private currentStatus: 'running' | 'stopped' | 'error' = 'stopped';

  constructor(
    private readonly name: string,
    private readonly config: StreamableHttpServerConfig,
  ) {}

  async connect(): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.config.url),
      this.config.headers
        ? { requestInit: { headers: this.config.headers } }
        : undefined,
    );

    this.client = new Client({
      name: `mcp-gateway/${this.name}`,
      version: '1.0.0',
    });

    this.transport.onclose = () => {
      if (this.currentStatus === 'running') {
        this.currentStatus = 'error';
      }
    };

    await this.client.connect(this.transport);
    await this.discoverTools();
    this.currentStatus = 'running';
  }

  async disconnect(): Promise<void> {
    this.currentStatus = 'stopped';
    try {
      await this.client?.close();
    } catch {
      // Ignore close errors during shutdown
    }
    this.client = null;
    this.transport = null;
    this.discoveredTools = [];
  }

  tools(): Tool[] {
    return this.discoveredTools;
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    if (!this.client || this.currentStatus !== 'running') {
      throw new UpstreamNotRunningError(this.name);
    }
    return this.client.callTool({
      name,
      arguments: args,
    }) as Promise<ToolCallResult>;
  }

  status(): 'running' | 'stopped' | 'error' {
    return this.currentStatus;
  }

  private async discoverTools(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.listTools();
    this.discoveredTools = result.tools;
  }
}
