import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpstreamNotRunningError } from './errors.js';

let capturedOnClose: (() => void) | undefined;
let connectBehavior: 'succeed' | 'fail' = 'succeed';
let connectCallCount = 0;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn(async () => {
      connectCallCount++;
      if (connectBehavior === 'fail' && connectCallCount > 1) {
        throw new Error('Connection failed');
      }
    });
    close = vi.fn(async () => {});
    listTools = vi.fn(async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Echo tool',
          inputSchema: { type: 'object' },
        },
      ],
    }));
    callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'result' }],
    }));
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockTransport {
    set onclose(handler: () => void) {
      capturedOnClose = handler;
    }
  },
}));

describe('StdioConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedOnClose = undefined;
    connectBehavior = 'succeed';
    connectCallCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createConnection(
    opts?: Partial<{ autoRestart: boolean; maxRestarts: number }>,
  ) {
    const { StdioConnection } = await import('./stdio-connection.js');
    return new StdioConnection('test', {
      transport: 'stdio',
      command: 'echo',
      ...opts,
    });
  }

  it('connects and discovers tools', async () => {
    const conn = await createConnection();
    await conn.connect();

    expect(conn.status()).toBe('running');
    expect(conn.tools()).toHaveLength(1);
    expect(conn.tools()[0].name).toBe('echo');
  });

  it('calls tool on upstream', async () => {
    const conn = await createConnection();
    await conn.connect();

    const result = await conn.callTool('echo', { message: 'hi' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'result' }],
    });
  });

  it('throws UpstreamNotRunningError when not connected', async () => {
    const conn = await createConnection();
    await expect(conn.callTool('echo')).rejects.toThrow(
      UpstreamNotRunningError,
    );
  });

  it('disconnects cleanly', async () => {
    const conn = await createConnection();
    await conn.connect();
    await conn.disconnect();

    expect(conn.status()).toBe('stopped');
    expect(conn.tools()).toHaveLength(0);
  });

  it('sets error status on unexpected close', async () => {
    const conn = await createConnection();
    await conn.connect();

    capturedOnClose?.();
    expect(conn.status()).toBe('error');
  });

  it('schedules restart with backoff after crash', async () => {
    const conn = await createConnection();
    await conn.connect();

    capturedOnClose?.();
    expect(conn.status()).toBe('error');

    await vi.advanceTimersByTimeAsync(1000);
    expect(conn.status()).toBe('running');
  });

  it('does not restart when autoRestart is false', async () => {
    const conn = await createConnection({ autoRestart: false });
    await conn.connect();
    expect(capturedOnClose).toBeUndefined();
  });

  it('does not restart after explicit disconnect', async () => {
    const conn = await createConnection();
    await conn.connect();
    await conn.disconnect();
    expect(conn.status()).toBe('stopped');
  });

  it('stops retrying after max restarts exceeded', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    connectBehavior = 'fail';

    const conn = await createConnection({ maxRestarts: 2 });
    await conn.connect(); // connectCallCount = 1 (succeeds)

    capturedOnClose?.();

    // Attempt 1: 1s backoff → fails (connectCallCount=2)
    await vi.advanceTimersByTimeAsync(1000);
    // Attempt 2: 2s backoff → fails (connectCallCount=3)
    await vi.advanceTimersByTimeAsync(2000);

    // No more attempts — exceeded max
    await vi.advanceTimersByTimeAsync(30_000);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('exceeded max restarts'),
    );
    consoleSpy.mockRestore();
  });

  it('uses exponential backoff between restart attempts', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    connectBehavior = 'fail';

    const conn = await createConnection({ maxRestarts: 5 });
    await conn.connect(); // connectCallCount = 1

    capturedOnClose?.();
    expect(conn.status()).toBe('error');

    // Before 1s: no restart
    await vi.advanceTimersByTimeAsync(999);
    expect(connectCallCount).toBe(1);

    // At 1s: first restart attempt
    await vi.advanceTimersByTimeAsync(1);
    expect(connectCallCount).toBe(2);

    // At +2s: second restart attempt
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectCallCount).toBe(3);

    // At +4s: third restart attempt
    await vi.advanceTimersByTimeAsync(4000);
    expect(connectCallCount).toBe(4);

    consoleSpy.mockRestore();
  });
});
