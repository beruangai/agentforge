import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type {
  MountedFilesystem,
  PushReport,
} from '../../../server/harness/filesystem/filesystem.ts';
import { toAgentOptions } from './agent-options.ts';
import { composeOptions } from './options.ts';
import { withFreshSdkServers } from './sdk-mcp-servers.ts';

function mounted(
  localPath: string,
  write: readonly string[] = [],
): MountedFilesystem {
  return {
    localPath,
    permissions: [
      { action: 'read', glob: '**' },
      ...write.map((glob) => ({ action: 'edit' as const, glob })),
    ],
    path: (relativePath) => `${localPath}/${relativePath}`,
    writablePath: (relativePath) => `${localPath}/${relativePath}`,
  };
}

/**
 * The server's instance connected to a transport the test speaks JSON-RPC
 * over, as a run's query connects it.
 */
async function connect(server: McpSdkServerConfigWithInstance) {
  const sent: { id?: number; result?: unknown; error?: unknown }[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    start: async () => {},
    send: async (message: (typeof sent)[number]) => {
      sent.push(message);
    },
    close: async () => {
      transport.onclose?.();
    },
  };
  await server.instance.connect(transport as never);
  let next = 0;
  const request = async (method: string, params: unknown) => {
    next += 1;
    const id = next;
    transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
    return vi.waitFor(() => {
      const response = sent.find((message) => message.id === id);
      if (response === undefined) throw new Error(`no answer to ${method}`);
      return response.result as Record<string, unknown>;
    });
  };
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  return { request, close: () => server.instance.close() };
}

describe('toAgentOptions', () => {
  it('renders a mount as an additional directory and its permissions as Claude Code rules', () => {
    expect(
      toAgentOptions({
        vault: mounted('/workspace/vault', ['notes/today.md']),
      }),
    ).toEqual({
      additionalDirectories: ['/workspace/vault'],
      allowedTools: [
        'Read(//workspace/vault/**)',
        'Edit(//workspace/vault/notes/today.md)',
      ],
    });
  });

  it('renders every mount, in order, without a rule twice', () => {
    expect(
      toAgentOptions({
        vault: mounted('/workspace/vault', ['**']),
        notes: mounted('/workspace/notes', ['**', '**']),
      }),
    ).toEqual({
      additionalDirectories: ['/workspace/vault', '/workspace/notes'],
      allowedTools: [
        'Read(//workspace/vault/**)',
        'Edit(//workspace/vault/**)',
        'Read(//workspace/notes/**)',
        'Edit(//workspace/notes/**)',
      ],
    });
  });

  it('is empty without mounts', () => {
    expect(toAgentOptions({})).toEqual({});
  });

  it('renders no rule for delete', () => {
    const vault = mounted('/workspace/vault', ['notes/**']);
    expect(
      toAgentOptions({
        vault: {
          ...vault,
          permissions: [
            ...vault.permissions,
            { action: 'delete', glob: 'notes/**' },
          ],
        },
      }).allowedTools,
    ).toEqual([
      'Read(//workspace/vault/**)',
      'Edit(//workspace/vault/notes/**)',
    ]);
  });

  describe('a mount that offers a push', () => {
    const report: PushReport = { commit: 'abc123', files: ['notes/a.md'] };
    const offering = (
      push: NonNullable<MountedFilesystem['push']>,
    ): MountedFilesystem => ({
      ...mounted('/workspace/vault', ['**']),
      push,
    });

    it('gets an allowed tool in the agentforge server, which pushes with its message', async () => {
      const messages: string[] = [];
      const options = toAgentOptions({
        vault: offering(async (message) => {
          messages.push(message);
          return report;
        }),
        notes: mounted('/workspace/notes'),
      });
      expect(options.allowedTools).toContain('mcp__agentforge__push_vault');
      const server = options.mcpServers
        ?.agentforge as McpSdkServerConfigWithInstance;
      const client = await connect(server);
      const listed = (await client.request('tools/list', {})) as {
        tools: { name: string }[];
      };
      expect(listed.tools.map((each) => each.name)).toEqual(['push_vault']);
      const result = await client.request('tools/call', {
        name: 'push_vault',
        arguments: { message: 'partial work' },
      });
      expect(messages).toEqual(['partial work']);
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0]?.text ?? ''),
      ).toEqual(report);
      await client.close();
    });

    it("reports a failed push to the agent as the tool's error", async () => {
      const options = toAgentOptions({
        vault: offering(() =>
          Promise.reject(new Error('another writer changed plan.md')),
        ),
      });
      const client = await connect(
        options.mcpServers?.agentforge as McpSdkServerConfigWithInstance,
      );
      const result = await client.request('tools/call', {
        name: 'push_vault',
        arguments: { message: 'partial work' },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'another writer changed plan.md' },
      ]);
      await client.close();
    });

    it("refuses a filesystem name whose tool's full name is over 64 characters", () => {
      expect(() =>
        toAgentOptions({ ['n'.repeat(43)]: offering(async () => report) }),
      ).toThrow(/longer than 64 characters/);
      expect(() =>
        toAgentOptions({ ['n'.repeat(42)]: offering(async () => report) }),
      ).not.toThrow();
    });

    it('keeps its server instance through composition, and a run gets a fresh one while another run holds it', async () => {
      const derived = toAgentOptions({ vault: offering(async () => report) });
      const composed = composeOptions({ maxTurns: 3 }, derived);
      const server = composed.mcpServers
        ?.agentforge as McpSdkServerConfigWithInstance;
      expect(server.instance).toBe(
        (derived.mcpServers as Record<string, McpSdkServerConfigWithInstance>)
          .agentforge?.instance,
      );
      expect(withFreshSdkServers(composed.mcpServers)?.agentforge).toBe(server);
      const client = await connect(server);
      const fresh = withFreshSdkServers(composed.mcpServers)
        ?.agentforge as McpSdkServerConfigWithInstance;
      expect(fresh.instance).not.toBe(server.instance);
      expect(fresh.instance.isConnected()).toBe(false);
      await client.close();
    });
  });
});

describe('withFreshSdkServers', () => {
  it("passes a consumer's own server as it is, even while connected", async () => {
    const { createSdkMcpServer } = await import(
      '@anthropic-ai/claude-agent-sdk'
    );
    const own = createSdkMcpServer({ name: 'own' });
    const client = await connect(own);
    expect(withFreshSdkServers({ own })?.own).toBe(own);
    await client.close();
  });
});
