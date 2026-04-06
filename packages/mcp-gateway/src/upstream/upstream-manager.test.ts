import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpstreamManager } from './upstream-manager.js';
import type { UpstreamConnection, ToolCallResult } from './types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

function createMockConnection(tools: Tool[]): UpstreamConnection {
  let connected = false;
  return {
    connect: vi.fn(async () => {
      connected = true;
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    tools: vi.fn(() => tools),
    callTool: vi.fn(
      async (
        name: string,
        args?: Record<string, unknown>,
      ): Promise<ToolCallResult> => ({
        content: [{ type: 'text', text: `called ${name}` }],
      }),
    ),
    status: vi.fn(() => (connected ? 'running' : 'stopped') as const),
  };
}

// Bypass private createConnection by subclassing
class TestableUpstreamManager extends UpstreamManager {
  private mockConnections = new Map<string, UpstreamConnection>();

  setMock(name: string, conn: UpstreamConnection): void {
    this.mockConnections.set(name, conn);
  }

  // Override connectAll to use mock connections
  override async connectAll(configs: Record<string, unknown>): Promise<void> {
    for (const [name, conn] of this.mockConnections) {
      (
        this as unknown as { servers: Map<string, UpstreamConnection> }
      ).servers.set(name, conn);
      await conn.connect();
    }
  }
}

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo tool',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
};

const greetTool: Tool = {
  name: 'greet',
  description: 'Greet tool',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
};

const searchTool: Tool = {
  name: 'search',
  description: 'Search tool',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

describe('UpstreamManager', () => {
  let manager: TestableUpstreamManager;
  let mockConn1: UpstreamConnection;
  let mockConn2: UpstreamConnection;

  beforeEach(() => {
    manager = new TestableUpstreamManager();
    mockConn1 = createMockConnection([echoTool, greetTool]);
    mockConn2 = createMockConnection([searchTool]);
    manager.setMock('server1', mockConn1);
    manager.setMock('server2', mockConn2);
  });

  it('connects all upstreams', async () => {
    await manager.connectAll({});
    expect(mockConn1.connect).toHaveBeenCalled();
    expect(mockConn2.connect).toHaveBeenCalled();
  });

  it('disconnects all upstreams', async () => {
    await manager.connectAll({});
    await manager.disconnectAll();
    expect(mockConn1.disconnect).toHaveBeenCalled();
    expect(mockConn2.disconnect).toHaveBeenCalled();
  });

  it('returns all tools with server prefix', async () => {
    await manager.connectAll({});
    const tools = manager.getAllTools();
    expect(tools).toEqual([
      {
        name: 'server1:echo',
        description: 'Echo tool',
        inputSchema: echoTool.inputSchema,
      },
      {
        name: 'server1:greet',
        description: 'Greet tool',
        inputSchema: greetTool.inputSchema,
      },
      {
        name: 'server2:search',
        description: 'Search tool',
        inputSchema: searchTool.inputSchema,
      },
    ]);
  });

  it('routes tool call to correct upstream, stripping prefix', async () => {
    await manager.connectAll({});
    await manager.callTool('server1:echo', { message: 'hi' });
    expect(mockConn1.callTool).toHaveBeenCalledWith('echo', { message: 'hi' });
  });

  it('routes to second upstream correctly', async () => {
    await manager.connectAll({});
    await manager.callTool('server2:search', { query: 'test' });
    expect(mockConn2.callTool).toHaveBeenCalledWith('search', {
      query: 'test',
    });
  });

  it('throws for unknown server prefix', async () => {
    await manager.connectAll({});
    await expect(manager.callTool('unknown:tool')).rejects.toThrow(
      "Unknown upstream server 'unknown'",
    );
  });

  it('throws for tool name without prefix', async () => {
    await manager.connectAll({});
    await expect(manager.callTool('noprefix')).rejects.toThrow(
      "Invalid tool name 'noprefix': missing server prefix",
    );
  });

  it('reports status for all upstreams', async () => {
    await manager.connectAll({});
    const status = manager.getStatus();
    expect(status.server1).toEqual(
      expect.objectContaining({
        status: 'running',
        toolCount: 2,
      }),
    );
    expect(status.server2).toEqual(
      expect.objectContaining({
        status: 'running',
        toolCount: 1,
      }),
    );
  });
});
