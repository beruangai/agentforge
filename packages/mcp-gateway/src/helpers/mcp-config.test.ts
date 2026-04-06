import { describe, it, expect } from 'vitest';
import { mcpConfigForGateway } from './mcp-config.js';

describe('mcpConfigForGateway', () => {
  it('generates config with gateway URL', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'host.docker.internal',
      gatewayPort: 8080,
    });

    expect(config).toEqual({
      gateway: {
        type: 'http',
        url: 'http://host.docker.internal:8080/mcp',
      },
    });
  });

  it('includes X-Tools header when tools specified', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'host.docker.internal',
      gatewayPort: 8080,
      tools: ['vault:*', 'serpapi:search'],
    });

    expect(config.gateway.headers).toEqual({
      'X-Tools': 'vault:*,serpapi:search',
    });
  });

  it('omits headers when no tools specified', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'localhost',
      gatewayPort: 3000,
    });

    expect(config.gateway.headers).toBeUndefined();
  });

  it('omits headers when empty tools array', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'localhost',
      gatewayPort: 3000,
      tools: [],
    });

    expect(config.gateway.headers).toBeUndefined();
  });

  it('supports HTTPS', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'gateway.example.com',
      gatewayPort: 443,
      https: true,
    });

    expect(config.gateway.url).toBe('https://gateway.example.com:443/mcp');
  });

  it('handles single tool', () => {
    const config = mcpConfigForGateway({
      gatewayHost: 'localhost',
      gatewayPort: 8080,
      tools: ['vault:read'],
    });

    expect(config.gateway.headers).toEqual({
      'X-Tools': 'vault:read',
    });
  });
});
