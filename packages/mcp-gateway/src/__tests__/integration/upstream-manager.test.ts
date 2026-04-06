import { describe, it, expect, afterEach } from 'vitest';
import { UpstreamManager } from '../../upstream/upstream-manager.js';
import { resolve } from 'node:path';

const MOCK_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../__fixtures__/mock-stdio-server.ts',
);

describe('UpstreamManager integration', () => {
  let manager: UpstreamManager;

  afterEach(async () => {
    await manager?.disconnectAll();
  });

  it('connects to stdio server, discovers tools, and calls them', async () => {
    manager = new UpstreamManager();
    await manager.connectAll({
      mock: {
        transport: 'stdio',
        command: 'bun',
        args: ['run', MOCK_SERVER_PATH],
      },
    });

    // Discover tools
    const tools = manager.getAllTools();
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mock:echo',
      'mock:greet',
    ]);

    // Call a tool
    const result = await manager.callTool('mock:echo', { message: 'hello' });
    expect(result).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'hello' }],
      }),
    );
  });

  it('reports status after connecting', async () => {
    manager = new UpstreamManager();
    await manager.connectAll({
      mock: {
        transport: 'stdio',
        command: 'bun',
        args: ['run', MOCK_SERVER_PATH],
      },
    });

    const status = manager.getStatus();
    expect(status.mock).toEqual({
      status: 'running',
      transport: 'stdio',
      toolCount: 2,
    });
  });

  it('handles multiple stdio upstreams', async () => {
    manager = new UpstreamManager();
    await manager.connectAll({
      alpha: {
        transport: 'stdio',
        command: 'bun',
        args: ['run', MOCK_SERVER_PATH],
      },
      beta: {
        transport: 'stdio',
        command: 'bun',
        args: ['run', MOCK_SERVER_PATH],
      },
    });

    const tools = manager.getAllTools();
    // Each server has 2 tools, prefixed differently
    expect(tools.length).toBe(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'alpha:echo',
      'alpha:greet',
      'beta:echo',
      'beta:greet',
    ]);

    // Route to correct upstream
    const result = await manager.callTool('beta:greet', { name: 'World' });
    expect(result).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Hello, World!' }],
      }),
    );
  });
});
