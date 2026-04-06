import type {
  VolumeMap,
  MessageBlock,
  MCPServerConfig,
  SandboxRunner,
} from '@beruangai/agentforge-claude-sandbox';
import type { Gateway } from '@beruangai/agentforge-mcp-gateway';
import type { z } from 'zod';

/**
 * Sandbox activity config — extends claude-sandbox's input types
 * with activity-specific concerns (tool filtering).
 * Maps to ExecuteConfig + AgentForgeContainerInput at execution time.
 */
export interface SandboxActivityConfig {
  // Maps to AgentForgeContainerInput
  prompt: string | MessageBlock[];
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: Record<string, unknown>;
  mcpServers?: Record<string, MCPServerConfig>;
  sessionId?: string;

  // Maps to ExecuteConfig
  volumes?: VolumeMap;
  env?: Record<string, string>;
  network?: string;

  // Activity-specific: tool filter patterns for gateway
  tools?: string[];
}

/**
 * Configuration for createClaudeSandboxActivity().
 */
export interface CreateClaudeSandboxActivityConfig<TInput, TOutput> {
  /** Activity name (used in tracing and logging) */
  name: string;

  /** SandboxRunner instance */
  runner: SandboxRunner;

  /** Gateway instance for MCP tool access */
  gateway?: Gateway;

  /** Build sandbox execution config from activity input */
  sandbox: (input: TInput) => SandboxActivityConfig;

  /** Zod schema for output validation (optional — skips validation if omitted) */
  outputSchema?: z.ZodType<TOutput>;

  /** Heartbeat interval in ms (default: 15000) */
  heartbeatInterval?: number;

  /** Execution timeout in ms (default: runner's default) */
  timeout?: number;
}
