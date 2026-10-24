import {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  type McpClient,
} from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { composeOptions, hook } from './options.ts';

const client = {} as McpClient;

describe('composeOptions', () => {
  it('lets a later part win a value, and accumulates lists', () => {
    expect(
      composeOptions(
        {
          model: 'claude-sonnet-5-5',
          workingDirectories: ['/a'],
          limits: { turns: 5 },
        },
        {
          model: 'claude-haiku-5-5',
          workingDirectories: ['/b'],
          limits: { outputTokens: 10 },
        },
      ),
    ).toEqual({
      model: 'claude-haiku-5-5',
      workingDirectories: ['/a', '/b'],
      limits: { turns: 5, outputTokens: 10 },
    });
  });

  it('accumulates hooks from every part', () => {
    const first = hook(BeforeToolCallEvent, () => {});
    const second = hook(AfterToolCallEvent, () => {}, { order: 1 });
    expect(
      composeOptions({ hooks: [first] }, { hooks: [second] }).hooks,
    ).toEqual([first, second]);
  });

  it('changes nothing for a value given as undefined', () => {
    expect(composeOptions({ model: 'm' }, { model: undefined })).toEqual({
      model: 'm',
    });
  });

  it('keeps MCP servers from every part', () => {
    expect(
      Object.keys(
        composeOptions(
          { mcpClients: { a: client } },
          { mcpClients: { b: client } },
        ).mcpClients ?? {},
      ),
    ).toEqual(['a', 'b']);
  });

  it('refuses an MCP server contributed twice', () => {
    expect(() =>
      composeOptions(
        { mcpClients: { docs: client } },
        { mcpClients: { docs: client } },
      ),
    ).toThrow('MCP server "docs" is contributed twice');
  });
});
