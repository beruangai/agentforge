import { Hono } from 'hono';
import type { UpstreamManager } from '../upstream/upstream-manager.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import {
  filterTools,
  isToolAllowed,
  parseToolFilter,
} from '../filter/tool-filter.js';
import {
  InvalidToolNameError,
  UnknownUpstreamError,
  UpstreamNotRunningError,
} from '../upstream/errors.js';

interface McpRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface ServerOptions {
  upstreamManager: UpstreamManager;
  rateLimiter: RateLimiter;
  logging: boolean;
}

export function createMcpApp(opts: ServerOptions): Hono {
  const { upstreamManager, rateLimiter, logging } = opts;
  const app = new Hono();

  app.post('/mcp', async (c) => {
    const toolFilter = parseToolFilter(c.req.raw.headers);

    let body: McpRequest;
    try {
      body = await c.req.json<McpRequest>();
    } catch {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
        400,
      );
    }

    switch (body.method) {
      case 'tools/list': {
        const allTools = upstreamManager.getAllTools();
        const filtered = filterTools(allTools, toolFilter);
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: filtered },
        });
      }

      case 'tools/call': {
        const params = body.params as
          | { name: string; arguments?: Record<string, unknown> }
          | undefined;
        if (!params?.name) {
          return c.json(
            {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32602, message: 'Missing tool name' },
            },
            400,
          );
        }

        const { name, arguments: args } = params;

        if (!isToolAllowed(name, toolFilter)) {
          return c.json(
            {
              jsonrpc: '2.0',
              id: body.id,
              error: {
                code: -32600,
                message: `Tool '${name}' not in allowed list`,
              },
            },
            403,
          );
        }

        const startTime = Date.now();

        try {
          // Rate limit with abort support for client disconnect
          const abortController = new AbortController();
          c.req.raw.signal.addEventListener(
            'abort',
            () => abortController.abort(),
            { once: true },
          );
          await rateLimiter.acquire(name, abortController.signal);
        } catch (err) {
          if (err instanceof Error && err.message.includes('aborted')) {
            return c.json(
              {
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'Request cancelled' },
              },
              408,
            );
          }
          throw err;
        }

        const queuedMs = Date.now() - startTime;

        try {
          const result = await upstreamManager.callTool(name, args);

          if (logging) {
            const durationMs = Date.now() - startTime;
            console.log(JSON.stringify({ tool: name, durationMs, queuedMs }));
          }

          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Internal error';

          if (err instanceof UpstreamNotRunningError) {
            return c.json(
              { jsonrpc: '2.0', id: body.id, error: { code: -32000, message } },
              503,
            );
          }
          if (
            err instanceof UnknownUpstreamError ||
            err instanceof InvalidToolNameError
          ) {
            return c.json(
              { jsonrpc: '2.0', id: body.id, error: { code: -32000, message } },
              500,
            );
          }

          return c.json(
            { jsonrpc: '2.0', id: body.id, error: { code: -32603, message } },
            500,
          );
        }
      }

      default:
        return c.json(
          {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Method not found' },
          },
          400,
        );
    }
  });

  return app;
}
