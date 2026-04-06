import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type UpstreamServerConfig =
  | StdioServerConfig
  | StreamableHttpServerConfig;

export interface StdioServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Restart on crash (default: true) */
  autoRestart?: boolean;
  /** Max restart attempts before giving up (default: 5) */
  maxRestarts?: number;
}

export interface StreamableHttpServerConfig {
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

/** Result from calling a tool on an upstream server */
export type ToolCallResult = Record<string, unknown>;

/**
 * Common interface for upstream MCP server connections.
 * Both stdio and streamable HTTP connections implement this.
 */
export interface UpstreamConnection {
  /** Connect to the upstream server and discover tools */
  connect(): Promise<void>;
  /** Disconnect from the upstream server */
  disconnect(): Promise<void>;
  /** Get the tools offered by this upstream (unprefixed names) */
  tools(): Tool[];
  /** Call a tool on this upstream (unprefixed name) */
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  /** Current connection status */
  status(): 'running' | 'stopped' | 'error';
}
