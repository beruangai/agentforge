import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Each SDK MCP server AgentForge creates, by its instance, with the factory
 * that makes another. One instance holds one transport: a query connects it
 * when it starts and closes it when it ends (SDK 0.3.280,
 * docs/research/claude-agent-sdk.md), so a second run while the first is
 * live could not connect it.
 */
const FACTORIES = new WeakMap<object, () => McpSdkServerConfigWithInstance>();

/** An SDK MCP server from `factory`, registered so a run can be given a fresh one. */
export function registeredSdkServer(
  factory: () => McpSdkServerConfigWithInstance,
): McpSdkServerConfigWithInstance {
  const server = factory();
  FACTORIES.set(server.instance, factory);
  return server;
}

/**
 * The run's MCP servers, with each registered one that is still connected —
 * another live run holds it — replaced by a fresh one from its factory. A
 * consumer's own servers are passed as they are.
 */
export function withFreshSdkServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (servers === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.type !== 'sdk') return [name, server];
      const factory = FACTORIES.get(server.instance);
      return [
        name,
        factory !== undefined && server.instance.isConnected()
          ? registeredSdkServer(factory)
          : server,
      ];
    }),
  );
}
