import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { StreamableHttpConnection } from './streamable-http-connection.js';
import { UpstreamNotRunningError } from './errors.js';
import { startMockStreamableHttpServer } from '../__fixtures__/mock-streamable-http-server.js';

function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

describe('StreamableHttpConnection', () => {
  let server: Server | undefined;
  let conn: StreamableHttpConnection | undefined;

  afterEach(async () => {
    await conn?.disconnect();
    conn = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    server = undefined;
  });

  it('connects to a Streamable HTTP server and discovers tools', async () => {
    const port = randomPort();
    server = await startMockStreamableHttpServer(port);

    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`,
    });

    await conn.connect();

    expect(conn.status()).toBe('running');
    expect(conn.tools().length).toBe(2);
    const names = conn
      .tools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['fetch', 'search']);
  });

  it('calls a tool and returns the result', async () => {
    const port = randomPort();
    server = await startMockStreamableHttpServer(port);

    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`,
    });

    await conn.connect();

    const result = await conn.callTool('search', { query: 'test' });
    expect(result).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'results for: test' }],
      }),
    );
  });

  it('disconnects cleanly', async () => {
    const port = randomPort();
    server = await startMockStreamableHttpServer(port);

    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`,
    });

    await conn.connect();
    await conn.disconnect();

    expect(conn.status()).toBe('stopped');
    expect(conn.tools()).toHaveLength(0);
  });

  it('throws UpstreamNotRunningError when not connected', async () => {
    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
    });

    await expect(conn.callTool('search', { query: 'x' })).rejects.toThrow(
      UpstreamNotRunningError,
    );
  });

  it('passes custom headers to the upstream', async () => {
    const port = randomPort();
    server = await startMockStreamableHttpServer(port);

    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer test-token' },
    });

    await conn.connect();
    // If headers caused a rejection, connect would have thrown
    expect(conn.status()).toBe('running');
  });

  it('handles connection failure gracefully', async () => {
    conn = new StreamableHttpConnection('http-test', {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp', // nothing listening
    });

    await expect(conn.connect()).rejects.toThrow();
    expect(conn.status()).toBe('stopped');
  });
});
