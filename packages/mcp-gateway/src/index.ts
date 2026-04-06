// Gateway
export { createGateway } from './gateway/create-gateway.js';
export type {
  Gateway,
  GatewayConfig,
  GatewayServerConfig,
  GatewayStatus,
} from './gateway/types.js';

// Container integration
export { mcpConfigForGateway } from './helpers/mcp-config.js';

// Tool filtering (useful for consumers building custom behavior)
export {
  filterTools,
  isToolAllowed,
  parseToolFilter,
} from './filter/tool-filter.js';
export type { GatewayTool } from './filter/types.js';

// Rate limiting types (for configuration)
export type { RateLimitConfig } from './rate-limit/types.js';

// Upstream types (for configuration)
export type {
  UpstreamServerConfig,
  StdioServerConfig,
  StreamableHttpServerConfig,
} from './upstream/types.js';

// Error types
export {
  InvalidToolNameError,
  UnknownUpstreamError,
  UpstreamNotRunningError,
} from './upstream/errors.js';
