import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentOptions } from './kernel.ts';
import { composeOptions } from './options.ts';

const guard = (matcher: string): HookCallbackMatcher => ({
  matcher,
  hooks: [async () => ({})],
});

describe('composeOptions', () => {
  it('accumulates lists, merges objects, and lets a later scalar win', () => {
    const house = guard('Bash');
    const own = guard('Write');
    expect(
      composeOptions(
        {
          model: 'sonnet',
          allowedTools: ['Read', 'Bash'],
          hooks: { PreToolUse: [house] },
          env: { A: '1', B: '1' },
        },
        {
          model: 'opus',
          allowedTools: ['Bash', 'Write'],
          hooks: { PreToolUse: [own], Stop: [guard('*')] },
          env: { B: '2' },
        },
      ),
    ).toEqual({
      model: 'opus',
      allowedTools: ['Read', 'Bash', 'Write'],
      hooks: { PreToolUse: [house, own], Stop: [expect.anything()] },
      env: { A: '1', B: '2' },
    });
  });

  it('keeps a guardrail a later part leaves undefined', () => {
    const house = guard('Bash');
    // As a consumer compiled without `exactOptionalPropertyTypes` may pass it.
    const procedure = {
      disallowedTools: undefined,
      hooks: undefined,
    } as unknown as AgentOptions;
    expect(
      composeOptions(
        { disallowedTools: ['WebFetch'], hooks: { PreToolUse: [house] } },
        procedure,
      ),
    ).toEqual({
      disallowedTools: ['WebFetch'],
      hooks: { PreToolUse: [house] },
    });
  });

  it('refuses an MCP server contributed twice', () => {
    const server = { type: 'stdio' as const, command: 'server' };
    expect(() =>
      composeOptions(
        { mcpServers: { tools: server } },
        { mcpServers: { tools: server } },
      ),
    ).toThrow('MCP server "tools" is contributed twice');
  });
});
