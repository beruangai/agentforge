import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  StdioServerConfig,
  ToolCallResult,
  UpstreamConnection,
} from './types.js';
import { UpstreamNotRunningError } from './errors.js';

const DEFAULT_MAX_RESTARTS = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class StdioConnection implements UpstreamConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private discoveredTools: Tool[] = [];
  private currentStatus: 'running' | 'stopped' | 'error' = 'stopped';
  private restartInProgress = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly name: string,
    private readonly config: StdioServerConfig,
  ) {}

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env
        ? ({ ...process.env, ...this.config.env } as Record<string, string>)
        : undefined,
      cwd: this.config.cwd,
      stderr: 'pipe',
    });

    this.client = new Client({
      name: `mcp-gateway/${this.name}`,
      version: '1.0.0',
    });

    const autoRestart = this.config.autoRestart ?? true;
    if (autoRestart) {
      this.transport.onclose = () => {
        if (this.currentStatus === 'running') {
          this.currentStatus = 'error';
          void this.scheduleRestart();
        }
      };
    }

    await this.client.connect(this.transport);
    await this.discoverTools();
    this.currentStatus = 'running';
    this.restartCount = 0;
  }

  async disconnect(): Promise<void> {
    this.currentStatus = 'stopped';
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
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

  private scheduleRestart(): void {
    const maxRestarts = this.config.maxRestarts ?? DEFAULT_MAX_RESTARTS;

    if (this.restartInProgress || this.currentStatus === 'stopped') return;

    if (this.restartCount >= maxRestarts) {
      console.error(
        `Upstream '${this.name}' exceeded max restarts (${maxRestarts}), giving up`,
      );
      return;
    }

    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, this.restartCount),
      MAX_BACKOFF_MS,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, backoffMs);

    if (
      this.restartTimer &&
      typeof this.restartTimer === 'object' &&
      'unref' in this.restartTimer
    ) {
      this.restartTimer.unref();
    }
  }

  private async restart(): Promise<void> {
    if (this.restartInProgress || this.currentStatus === 'stopped') return;
    this.restartInProgress = true;
    this.restartCount++;

    try {
      try {
        await this.client?.close();
      } catch {
        // Ignore
      }
      this.client = null;
      this.transport = null;

      await this.connect();
    } catch (err) {
      this.currentStatus = 'error';
      console.error(
        `Failed to restart upstream '${this.name}' (attempt ${this.restartCount}):`,
        err,
      );
      // Schedule another attempt with increased backoff
      this.restartInProgress = false;
      this.scheduleRestart();
      return;
    } finally {
      this.restartInProgress = false;
    }
  }
}
