/**
 * Types shared between the agent-runner (Docker) and the host runner.
 * This module is the source of truth — runner/types.ts re-exports from here.
 */

export interface MessageBlock {
  type: 'text' | 'document' | 'image';
  text?: string;
  title?: string;
  content?: string;
  filePath?: string;
  source?: string;
  mediaType?: string;
}

export interface MCPServerConfig {
  type: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Input sent to the agent-runner process inside the container via stdin.
 */
export interface AgentForgeContainerInput {
  /** Task name (used in tracing and container naming) */
  name: string;
  /** Prompt for the agent (string or message blocks) */
  prompt: string | MessageBlock[];
  /** Model to use (e.g., 'sonnet', 'haiku', 'opus') */
  model?: string;
  /** Maximum agent turns */
  maxTurns?: number;
  /** Allowed tools whitelist */
  allowedTools?: string[];
  /** Disallowed tools blacklist */
  disallowedTools?: string[];
  /** JSON Schema for structured output (draft-07) */
  outputFormat?: Record<string, unknown>;
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Session ID for resumption */
  sessionId?: string;
  /** Additional env vars to pass to Agent SDK */
  env?: Record<string, string>;
}

/**
 * Output emitted by the agent-runner process via sentinel-wrapped stdout.
 */
export interface AgentForgeContainerOutput {
  status: 'success' | 'error';
  structuredOutput?: unknown;
  sessionId?: string;
  metrics?: {
    /** Aggregate token usage from SDK */
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    /** Total cost in USD */
    totalCostUsd?: number;
    /** Wall-clock duration ms */
    durationMs: number;
    /** API-only duration ms */
    durationApiMs?: number;
    /** Number of conversation turns */
    numTurns?: number;
  };
  error?: string;
}
