// Re-export agent-runner types (source of truth lives in agent-runner/types.ts)
export type {
  AgentForgeContainerInput,
  AgentForgeContainerOutput,
  MessageBlock,
  MCPServerConfig,
} from '../agent-runner/types.js';

// Import for local use in this file's interfaces
import type { AgentForgeContainerInput } from '../agent-runner/types.js';

/**
 * Configuration for the SandboxRunner instance.
 */
export interface SandboxRunnerConfig {
  /** Docker image tag (default: 'agentforge-claude:latest') */
  image?: string;
  /** Custom Dockerfile path (overrides bundled default) */
  dockerfile?: string;
  /** Default execution timeout in ms (default: 300000) */
  defaultTimeout?: number;
  /** Remove containers after execution (default: true) */
  cleanupOnExit?: boolean;
  /** Host directory for session persistence (default: ./data/sessions) */
  sessionsDir?: string;
  /** Credential injection mode */
  credentials?: CredentialConfig;
}

export interface CredentialConfig {
  /** 'env' = pass API key as env var; 'onecli' = use OneCLI HTTPS proxy; 'proxy' = native credential proxy */
  mode: 'env' | 'onecli' | 'proxy';
  /** OneCLI proxy URL (required for 'onecli' mode) */
  proxyUrl?: string;
  /** Credential proxy URL (required for 'proxy' mode, default: http://host.docker.internal:3128) */
  credentialProxyUrl?: string;
  /** Agent identifier for multi-credential OneCLI (optional) */
  agent?: string;
}

/**
 * Configuration for a single execution.
 */
export interface ExecuteConfig {
  /** Agent task input (sent to agent-runner via stdin) */
  input: AgentForgeContainerInput;
  /** Volume mounts: host path → container path or { target, readonly } */
  volumes?: VolumeMap;
  /** Environment variables for the container */
  env?: Record<string, string>;
  /** Execution timeout in ms (overrides runner default) */
  timeout?: number;
  /** Docker network to attach container to */
  network?: string;
  /** Extra /etc/hosts entries (default: ['host.docker.internal:host-gateway']) */
  extraHosts?: string[];
}

export type VolumeMap = Record<
  string,
  string | { target: string; readonly?: boolean }
>;
