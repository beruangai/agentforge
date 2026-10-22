/**
 * `@beruangai/agentforge/client` — the caller-agnostic client, typed by the
 * contract a caller imports, over a local container or AgentCore.
 */
export {
  type AgentForgeClient,
  awaitTask,
  createClient,
  type ProcedureClient,
  type Routed,
  type Starting,
  type TaskView,
  type TerminalTaskView,
} from './client.ts';
export { localContainerTransport } from './local-container-transport.ts';
export {
  agentCoreTransportsFromRuntimeConfig,
  type RuntimeConfigSource,
} from './runtime-config.ts';
export {
  AgentForgeRequestError,
  agentCoreTransport,
  localTransport,
  StartRefusedError,
  type TaskMethod,
  type Transport,
} from './transport.ts';
