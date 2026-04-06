import { describe, it, expect, afterEach } from 'vitest';
import { createGateway } from '../../gateway/create-gateway.js';
import type { Gateway } from '../../gateway/types.js';
import { resolve } from 'node:path';

const MOCK_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../__fixtures__/mock-stdio-server.ts',
);

// Use a random port to avoid conflicts
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

async function jsonPost(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('MCP Gateway integration', () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway?.close();
  });

  it('starts gateway and lists tools from upstream', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { status, body } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(status).toBe(200);
    const toolNames = body.result.tools
      .map((t: { name: string }) => t.name)
      .sort();
    expect(toolNames).toEqual(['mock:echo', 'mock:greet']);
  });

  it('calls a tool and returns the result', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { status, body } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'mock:echo', arguments: { message: 'test' } },
    });

    expect(status).toBe(200);
    expect(body.result.content).toEqual([{ type: 'text', text: 'test' }]);
  });

  it('filters tools via X-Tools header', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    // List with filter
    const { body } = await jsonPost(
      `http://127.0.0.1:${port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'X-Tools': 'mock:echo' },
    );
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0].name).toBe('mock:echo');
  });

  it('rejects tool call for filtered-out tool (403)', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { status, body } = await jsonPost(
      `http://127.0.0.1:${port}/mcp`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mock:greet', arguments: { name: 'X' } },
      },
      { 'X-Tools': 'mock:echo' },
    );

    expect(status).toBe(403);
    expect(body.error.message).toContain('not in allowed list');
  });

  it('returns 400 for unknown MCP method', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { status, body } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'unknown/method',
    });

    expect(status).toBe(400);
    expect(body.error.message).toBe('Method not found');
  });

  it('reports gateway status', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const s = gateway.status();
    expect(s.port).toBe(port);
    expect(s.upstreams.mock).toEqual({
      status: 'running',
      transport: 'stdio',
      toolCount: 2,
    });
  });

  it('supports multiple upstreams with correct routing', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
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
      },
    });

    // List shows all tools from both upstreams
    const { body: listBody } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const names = listBody.result.tools
      .map((t: { name: string }) => t.name)
      .sort();
    expect(names).toEqual([
      'alpha:echo',
      'alpha:greet',
      'beta:echo',
      'beta:greet',
    ]);

    // Call routes to correct upstream
    const { body: callBody } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'beta:greet', arguments: { name: 'World' } },
    });
    expect(callBody.result.content).toEqual([
      { type: 'text', text: 'Hello, World!' },
    ]);
  });

  it('returns 500 for unknown upstream prefix', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { status, body } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'unknown:tool', arguments: {} },
    });

    expect(status).toBe(500);
    expect(body.error.message).toContain('Unknown upstream server');
  });

  it('no X-Tools header allows all tools', async () => {
    const port = randomPort();
    gateway = await createGateway({
      port,
      logging: false,
      servers: {
        mock: {
          transport: 'stdio',
          command: 'bun',
          args: ['run', MOCK_SERVER_PATH],
        },
      },
    });

    const { body } = await jsonPost(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    // No X-Tools header → all tools returned
    expect(body.result.tools).toHaveLength(2);
  });
});
