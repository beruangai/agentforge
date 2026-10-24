import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { afterEach, describe, expect, it } from 'vitest';
import type { MountedFilesystem } from '../../../server/harness/filesystem/filesystem.ts';
import { runScripted, submit } from './__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  scriptedAnthropic,
  toolResults,
} from './__fixtures__/scripted-anthropic.ts';
import { toAgentOptions, withinWriteScope } from './agent-options.ts';

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

let api: ScriptedAnthropic | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('withinWriteScope', () => {
  const vault = mounted('/workspace/vault', ['notes/*.md']);
  it.each([
    ['/workspace/vault/notes/today.md', true],
    ['/workspace/vault/notes/deep/today.md', false],
    ['/workspace/vault/other.md', false],
    ['/workspace/vault', false],
    ['/workspace/vault/../elsewhere/notes/a.md', false],
    ['/elsewhere/notes/today.md', false],
  ])('%s → %s', (target, expected) => {
    expect(withinWriteScope([vault], target)).toBe(expected);
  });
});

describe('toAgentOptions', () => {
  it('gives nothing without mounts', () => {
    expect(toAgentOptions({})).toEqual({});
  });

  it('names every mount as a working directory, and one intervention', () => {
    const options = toAgentOptions({
      vault: mounted('/workspace/vault'),
      notes: mounted('/workspace/notes'),
    });
    expect(options.workingDirectories).toEqual([
      '/workspace/vault',
      '/workspace/notes',
    ]);
    expect(options.interventions).toHaveLength(1);
  });

  it("refuses the file tool's edit outside the write scope in turn, and permits one inside", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'strands-scope-'));
    const inside = path.join(root, 'notes/today.md');
    const outside = path.join(root, 'secret.md');
    const view = path.join(root, 'notes');
    api = await scriptedAnthropic([
      {
        toolCalls: [
          {
            name: fileEditor.name,
            input: { command: 'create', path: inside, file_text: 'in' },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: fileEditor.name,
            input: { command: 'create', path: outside, file_text: 'out' },
          },
        ],
      },
      {
        toolCalls: [
          { name: fileEditor.name, input: { command: 'view', path: view } },
        ],
      },
      submit({ answer: 'done' }),
    ]);
    const mounts = toAgentOptions({ work: mounted(root, ['notes/**']) });
    await runScripted(api, {
      options: {
        model: 'claude-test',
        maxTokens: 1024,
        tools: [fileEditor],
        ...mounts,
      },
    }).promise;
    expect(await readFile(inside, 'utf8')).toBe('in');
    await expect(readFile(outside, 'utf8')).rejects.toThrow();
    expect(toolResults(api.requests[1])[0]?.isError).toBe(false);
    expect(toolResults(api.requests[2])[0]).toMatchObject({ isError: true });
    expect(toolResults(api.requests[2])[0]?.text).toContain('DENIED');
    expect(toolResults(api.requests[3])[0]?.isError).toBe(false);
  });
});

describe('a mount that offers a push', () => {
  const offering = (
    push: NonNullable<MountedFilesystem['push']>,
  ): MountedFilesystem => ({ ...mounted('/workspace/vault', ['**']), push });

  it('gets a tool that pushes with its message, and a mount that offers none gets none', async () => {
    const messages: string[] = [];
    const options = toAgentOptions({
      vault: offering(async (message) => {
        messages.push(message);
        return { commit: 'abc123', files: ['notes/a.md'] };
      }),
      notes: mounted('/workspace/notes'),
    });
    const [push, ...others] = options.tools ?? [];
    expect(others).toEqual([]);
    expect((push as { name?: string } | undefined)?.name).toBe('push_vault');
    const result = await (
      push as unknown as { invoke(input: unknown): Promise<unknown> }
    ).invoke({ message: 'partial work' });
    expect(messages).toEqual(['partial work']);
    expect(JSON.parse(String(result))).toEqual({
      commit: 'abc123',
      files: ['notes/a.md'],
    });
    expect(
      toAgentOptions({ notes: mounted('/workspace/notes') }),
    ).not.toHaveProperty('tools');
  });

  it("fails the tool with the push's failure", async () => {
    const [push] =
      toAgentOptions({
        vault: offering(() =>
          Promise.reject(new Error('another writer changed plan.md')),
        ),
      }).tools ?? [];
    await expect(
      (push as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        message: 'partial work',
      }),
    ).rejects.toThrow('another writer changed plan.md');
  });

  it('refuses a filesystem name whose tool name is over 64 characters', () => {
    const push = async () => ({ files: [] });
    expect(() => toAgentOptions({ ['n'.repeat(60)]: offering(push) })).toThrow(
      /longer than 64 characters/,
    );
    expect(() =>
      toAgentOptions({ ['n'.repeat(59)]: offering(push) }),
    ).not.toThrow();
  });
});

describe('delete', () => {
  it('grants no edit through the file tool', () => {
    const vault: MountedFilesystem = {
      ...mounted('/workspace/vault'),
      permissions: [
        { action: 'read', glob: '**' },
        { action: 'delete', glob: 'notes/**' },
      ],
    };
    expect(withinWriteScope([vault], '/workspace/vault/notes/a.md')).toBe(
      false,
    );
  });
});
