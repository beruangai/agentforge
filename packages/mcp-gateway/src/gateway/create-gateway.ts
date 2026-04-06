import { createAdaptorServer } from '@hono/node-server';
import { UpstreamManager } from '../upstream/upstream-manager.js';
import { RateLimiter } from '../rate-limit/rate-limiter.js';
import type { RateLimitConfig } from '../rate-limit/types.js';
import type { UpstreamServerConfig } from '../upstream/types.js';
import { mcpConfigForGateway } from '../helpers/mcp-config.js';
import type { GatewayMcpServerEntry } from '../helpers/mcp-config.js';
import { createMcpApp } from './server.js';
import type { Gateway, GatewayConfig, GatewayStatus } from './types.js';

const DEFAULT_CONTAINER_HOST = 'host.docker.internal';

/**
 * Creates and starts the MCP gateway server.
 * Connects to all upstream servers before accepting requests.
 */
export async function createGateway(config: GatewayConfig): Promise<Gateway> {
  const {
    port,
    host = '0.0.0.0',
    servers,
    logging = true,
    containerHost = DEFAULT_CONTAINER_HOST,
  } = config;

  // Separate upstream configs from rate limit configs
  const upstreamConfigs: Record<string, UpstreamServerConfig> = {};
  const rateLimitConfigs: Record<string, RateLimitConfig | undefined> = {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    const { rateLimit, ...upstream } = serverConfig;
    upstreamConfigs[name] = upstream as UpstreamServerConfig;
    rateLimitConfigs[name] = rateLimit;
  }

  // Connect to all upstreams
  const upstreamManager = new UpstreamManager();
  await upstreamManager.connectAll(upstreamConfigs);

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(rateLimitConfigs);

  // Create and start HTTP server (wait for it to be listening)
  const app = createMcpApp({ upstreamManager, rateLimiter, logging });
  const httpServer = createAdaptorServer({ fetch: app.fetch });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  const gateway: Gateway = {
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      rateLimiter.destroy();
      await upstreamManager.disconnectAll();
    },

    status(): GatewayStatus {
      return {
        port,
        upstreams: upstreamManager.getStatus(),
      };
    },

    mcpServersConfig(
      tools?: string[],
    ): Record<string, GatewayMcpServerEntry> {
      return mcpConfigForGateway({
        gatewayHost: containerHost,
        gatewayPort: port,
        tools,
      });
    },
  };

  return gateway;
}
