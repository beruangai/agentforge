import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpClient, tool } from '@strands-agents/sdk';
import { InMemoryStorage, type Storage } from '@strands-agents/sdk/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TaskCanceled } from '../../../server/harness/task-failure.ts';
import { STRANDS_SDK_FULL_NAME } from '../core/sdk-version.ts';
import { latestSnapshotKey } from '../core/session-keys.ts';
import { failureOf, runScripted, submit } from './__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  type ScriptedStep,
  scriptedAnthropic,
  toolResults,
} from './__fixtures__/scripted-anthropic.ts';
import { STRUCTURED_OUTPUT_TOOL } from './runner.ts';
import type { AgentStorage } from './storage.ts';

let api: ScriptedAnthropic | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  vi.restoreAllMocks();
});

async function scripted(steps: readonly ScriptedStep[]) {
  api = await scriptedAnthropic(steps);
  return api;
}

/** The scripted API this test started. */
function current(): ScriptedAnthropic {
  if (api === undefined) throw new Error('no scripted API started');
  return api;
}

function agentStorage(storage: Storage = new InMemoryStorage()): AgentStorage {
  return { bucket: 'sessions', agent: 'writer', storage };
}

const textOf = (blocks: unknown): string => JSON.stringify(blocks ?? null);

describe('runAgent', () => {
  it('settles on the first accepted structured output, and records the run', async () => {
    const { requests } = await scripted([submit({ answer: 'a' })]);
    const { promise, records } = runScripted(current());
    const run = await promise;
    expect(run.output).toEqual({ answer: 'a' });
    expect(requests).toHaveLength(1);
    expect(run.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 3,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      framework: { name: 'strands', fullName: STRANDS_SDK_FULL_NAME },
      sessionId: run.sessionId,
      numberOfTurns: 1,
      options: { model: 'claude-test', maxTokens: 1024 },
    });
    expect(records[0]).not.toHaveProperty('transcript');
    expect(records[0]).not.toHaveProperty('totalCostUsd');
    expect(records[0]?.rawUsage).toEqual(run.rawUsage);
    expect(run.rawUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('tells the agent a refused submission in its turn, and accepts the next', async () => {
    const { requests } = await scripted([
      submit({ answer: 1 }),
      submit({ answer: 'b' }),
    ]);
    const run = await runScripted(current()).promise;
    expect(run.output).toEqual({ answer: 'b' });
    const [result] = toolResults(requests[1]);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('answer');
  });

  it('fails OUTPUT_INVALID at the attempt cap, with the last submission', async () => {
    const { requests } = await scripted([
      submit({ answer: 1 }),
      submit({ answer: 2 }),
    ]);
    const failure = await failureOf(
      runScripted(current(), { maxStructuredOutputAttempts: 2 }).promise,
    );
    expect(failure.code).toBe('OUTPUT_INVALID');
    expect(failure.message).toContain('2 attempts');
    expect(failure.payload).toEqual({ answer: 2 });
    expect(requests).toHaveLength(2);
  });

  it('fails OUTPUT_INVALID at five attempts by default', async () => {
    const { requests } = await scripted(
      [1, 2, 3, 4, 5].map((answer) => submit({ answer })),
    );
    const failure = await failureOf(runScripted(current()).promise);
    expect(failure.code).toBe('OUTPUT_INVALID');
    expect(failure.message).toContain('5 attempts');
    expect(requests).toHaveLength(5);
  });

  it('tells the agent a stop guard denial, as a refusal', async () => {
    const { requests } = await scripted([
      submit({ answer: 'a' }),
      submit({ answer: 'b' }),
    ]);
    let calls = 0;
    const run = await runScripted(current(), {
      guardrails: {
        stop: [async () => (++calls === 1 ? { reason: 'not yet' } : undefined)],
      },
    }).promise;
    expect(run.output).toEqual({ answer: 'b' });
    expect(toolResults(requests[1])[0]?.text).toContain('not yet');
  });

  it('fails EXECUTION_ERROR when a stop guard throws, and asks nothing more', async () => {
    const { requests } = await scripted([submit({ answer: 'a' })]);
    const failure = await failureOf(
      runScripted(current(), {
        guardrails: {
          stop: [
            async () => {
              throw new Error('guard defect');
            },
          ],
        },
      }).promise,
    );
    expect(failure.code).toBe('EXECUTION_ERROR');
    expect(failure.message).toContain('guard defect');
    expect(requests).toHaveLength(1);
  });

  it('fails OUTPUT_INVALID when the agent ends its turn without submitting, without forcing the tool', async () => {
    const { requests } = await scripted([{ text: 'done, I think' }]);
    const failure = await failureOf(runScripted(current()).promise);
    expect(failure.code).toBe('OUTPUT_INVALID');
    expect(failure.message).toBe('the run ended without structured output');
    expect(failure.payload).toBe('done, I think');
    expect(requests).toHaveLength(1);
  });

  it('names the last refusal when the agent ends its turn after one', async () => {
    await scripted([submit({ answer: 1 }), { text: 'giving up' }]);
    const failure = await failureOf(runScripted(current()).promise);
    expect(failure.code).toBe('OUTPUT_INVALID');
    expect(failure.message).toContain('the last was refused');
  });

  it('settles on the accepted one of two submissions in one message', async () => {
    const { requests } = await scripted([
      {
        toolCalls: [
          { name: STRUCTURED_OUTPUT_TOOL, input: { answer: 1 } },
          { name: STRUCTURED_OUTPUT_TOOL, input: { answer: 'second' } },
        ],
      },
    ]);
    const run = await runScripted(current()).promise;
    expect(run.output).toEqual({ answer: 'second' });
    expect(requests).toHaveLength(1);
  });

  it('settles on the first of two accepted submissions in one message', async () => {
    const { requests } = await scripted([
      {
        toolCalls: [
          { name: STRUCTURED_OUTPUT_TOOL, input: { answer: 'first' } },
          { name: STRUCTURED_OUTPUT_TOOL, input: { answer: 'second' } },
        ],
      },
    ]);
    const run = await runScripted(current()).promise;
    expect(run.output).toEqual({ answer: 'first' });
    expect(requests).toHaveLength(1);
  });

  it('nests a non-object contract under a property on the wire when opted in', async () => {
    const { requests } = await scripted([submit({ output: ['a', 'b'] })]);
    const run = await runScripted<string[]>(current(), {
      output: z.array(z.string()),
      wrapNonObjectOutput: true,
    }).promise;
    expect(run.output).toEqual(['a', 'b']);
    expect(textOf(requests[0]?.tools)).toContain('"output"');
  });

  it('marks the block a cache breakpoint ends, and nothing else', async () => {
    const { requests } = await scripted([submit({ answer: 'a' })]);
    await runScripted(current(), {
      prompt: [{ context: 'shared rules', cache: true }, 'q'],
    }).promise;
    const content = requests[0]?.messages[0]?.content ?? [];
    expect(content[0]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(content.filter((block) => 'cache_control' in block)).toHaveLength(1);
    expect(textOf(requests[0]?.system)).not.toContain('cache_control');
  });

  it('fails BUDGET_EXHAUSTED when a limit is reached', async () => {
    await scripted([submit({ answer: 1 })]);
    const failure = await failureOf(
      runScripted(current(), {
        options: {
          model: 'claude-test',
          maxTokens: 1024,
          limits: { turns: 1 },
        },
      }).promise,
    );
    expect(failure.code).toBe('BUDGET_EXHAUSTED');
    expect(failure.message).toContain('limitTurns');
  });

  it('keeps an accepted outcome when the telemetry does not flush', async () => {
    await scripted([submit({ answer: 'a' })]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await runScripted(
      current(),
      {},
      {
        flushTelemetry: async () => {
          throw new Error('collector down');
        },
      },
    ).promise;
    expect(run.output).toEqual({ answer: 'a' });
    expect(console.error).toHaveBeenCalledWith(
      "the run's telemetry did not flush",
      expect.any(Error),
    );
  });

  it('is cancelled by the task signal mid-request', async () => {
    const { requests } = await scripted([{ hang: true }]);
    const controller = new AbortController();
    const { promise, records } = runScripted(
      current(),
      {},
      {},
      controller.signal,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(TaskCanceled);
    expect(records).toHaveLength(1);
  });

  it('is cancelled before anything runs when the signal is already aborted', async () => {
    const { requests } = await scripted([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runScripted(current(), {}, {}, controller.signal).promise,
    ).rejects.toBeInstanceOf(TaskCanceled);
    expect(requests).toHaveLength(0);
  });

  describe('refuses what it cannot run, before the model', () => {
    const closed = {
      continueOnError: false,
      connect: async () => {},
      disconnect: async () => {},
    };
    it.each([
      ['no model', { options: {} }, 'names its model'],
      [
        'backgroundTasks',
        { options: { model: 'm', backgroundTasks: true } },
        'backgroundTasks',
      ],
      [
        'the provider cacheConfig',
        { options: { model: 'm', modelConfig: { cacheConfig: {} } } },
        'cacheConfig',
      ],
      ...['apiKey', 'client', 'clientConfig'].map(
        (key): [string, object, string] => [
          `the provider ${key}`,
          { options: { model: 'm', modelConfig: { [key]: {} } } },
          `sets no \`${key}\``,
        ],
      ),
      [
        'an MCP server that continues on error',
        {
          options: {
            model: 'm',
            mcpClients: { docs: { ...closed, continueOnError: true } },
          },
        },
        'MCP server "docs" is set to continue on error',
      ],
      [
        'a memory space with no storage',
        { memorySpace: 'notes' },
        'memory space',
      ],
      ['a resume with no storage', { resume: 'abc' }, 'resumes session'],
      [
        'offloading with no storage',
        { offload: { maxResultTokens: 100 } },
        'offloads tool results',
      ],
      [
        'an attempt cap below one',
        { maxStructuredOutputAttempts: 0 },
        'maxStructuredOutputAttempts',
      ],
      [
        'a non-object contract not opted in',
        { output: z.array(z.string()) },
        'root is not an object',
      ],
    ])('%s', async (_name, spec, message) => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const failure = await failureOf(
        runScripted(current(), spec as never).promise,
      );
      expect(failure.code).toBe('EXECUTION_ERROR');
      expect(failure.message).toContain(message);
      expect(requests).toHaveLength(0);
    });

    it('an MCP server that does not start', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const docs = {
        ...closed,
        connect: async () => {
          throw new Error('spawn failed');
        },
      } as unknown as McpClient;
      const failure = await failureOf(
        runScripted(current(), {
          options: { model: 'm', mcpClients: { docs } },
        }).promise,
      );
      expect(failure.code).toBe('EXECUTION_ERROR');
      expect(failure.message).toContain('MCP server "docs" did not start');
      expect(failure.message).toContain('spawn failed');
      expect(requests).toHaveLength(0);
    });
  });

  describe('MCP servers', () => {
    /** A real client, whose connection is `connect`: the Agent takes MCP servers by class. */
    function mcpClient(connect: (signal: AbortSignal) => Promise<void>) {
      const mcp = new McpClient({
        transport: {
          start: async () => {},
          send: async () => {},
          close: async () => {},
        } as never,
      });
      const client = {
        connect: vi
          .spyOn(mcp, 'connect')
          .mockImplementation(async (_reconnect, options) =>
            connect(options?.signal ?? new AbortController().signal),
          ),
        disconnect: vi.spyOn(mcp, 'disconnect').mockResolvedValue(undefined),
      };
      vi.spyOn(mcp, 'listTools').mockResolvedValue([]);
      return { client, mcp };
    }

    it('disconnects every server once the run is over', async () => {
      await scripted([submit({ answer: 'a' })]);
      const docs = mcpClient(async () => {});
      await runScripted(current(), {
        options: { model: 'm', mcpClients: { docs: docs.mcp } },
      }).promise;
      expect(docs.client.disconnect).toHaveBeenCalledOnce();
    });

    it('disconnects the servers that started when another does not', async () => {
      await scripted([]);
      const docs = mcpClient(async () => {});
      const search = mcpClient(async () => {
        throw new Error('spawn failed');
      });
      await failureOf(
        runScripted(current(), {
          options: {
            model: 'm',
            mcpClients: { docs: docs.mcp, search: search.mcp },
          },
        }).promise,
      );
      expect(docs.client.disconnect).toHaveBeenCalledOnce();
    });

    it('stops waiting for a server to start when the task is cancelled', async () => {
      await scripted([]);
      const hung = mcpClient(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      );
      const controller = new AbortController();
      const { promise } = runScripted(
        current(),
        { options: { model: 'm', mcpClients: { hung: hung.mcp } } },
        {},
        controller.signal,
      );
      await vi.waitFor(() => expect(hung.client.connect).toHaveBeenCalled());
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(TaskCanceled);
    });
  });

  describe('storage', () => {
    it('keeps the session under its id and names the transcript', async () => {
      await scripted([submit({ answer: 'a' })]);
      const storage = agentStorage();
      const { promise, records } = runScripted(current(), {}, { storage });
      const run = await promise;
      expect(
        await storage.storage.read(latestSnapshotKey(run.sessionId)),
      ).not.toBeNull();
      expect(records[0]?.transcript).toEqual({
        bucket: 'sessions',
        agent: 'writer',
      });
    });

    it('resumes a kept session with its messages', async () => {
      const { requests } = await scripted([
        submit({ answer: 'first' }),
        submit({ answer: 'second' }),
      ]);
      const storage = agentStorage();
      const first = await runScripted(
        current(),
        { prompt: 'remember 42' },
        { storage },
      ).promise;
      const second = await runScripted(
        current(),
        { prompt: 'what was it?', resume: first.sessionId },
        { storage },
      ).promise;
      expect(second.sessionId).toBe(first.sessionId);
      expect(textOf(requests[1]?.messages)).toContain('remember 42');
    });

    it('keeps a memory in its space, in the storage, and offers the memory tools', async () => {
      const { requests } = await scripted([
        {
          toolCalls: [
            { name: 'add_memory', input: { entries: ['the code is 42'] } },
          ],
        },
        submit({ answer: 'a' }),
      ]);
      const storage = agentStorage();
      await runScripted(current(), { memorySpace: 'notes' }, { storage })
        .promise;
      const names = requests[0]?.tools?.map((entry) => entry.name);
      expect(names).toEqual(
        expect.arrayContaining(['add_memory', 'search_memory']),
      );
      expect(toolResults(requests[1])[0]?.isError).toBe(false);
      const kept = await storage.storage.list('memory/notes/');
      expect(kept).toHaveLength(1);
      expect(
        new TextDecoder().decode(
          (await storage.storage.read(kept[0] ?? '')) ?? undefined,
        ),
      ).toContain('the code is 42');
    });

    it('offers no memory tools to a run that declares no memory space', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      await runScripted(current(), {}, { storage: agentStorage() }).promise;
      const names = requests[0]?.tools?.map((entry) => entry.name);
      expect(names).not.toContain('add_memory');
      expect(names).not.toContain('search_memory');
    });

    it('recalls in a later run what an earlier one kept in the same space', async () => {
      const { requests } = await scripted([
        {
          toolCalls: [
            { name: 'add_memory', input: { entries: ['the code is 42'] } },
          ],
        },
        submit({ answer: 'kept' }),
        {
          toolCalls: [{ name: 'search_memory', input: { query: 'code' } }],
        },
        submit({ answer: '42' }),
      ]);
      const storage = agentStorage();
      await runScripted(current(), { memorySpace: 'notes' }, { storage })
        .promise;
      await runScripted(current(), { memorySpace: 'notes' }, { storage })
        .promise;
      const [recalled] = toolResults(requests[3]);
      expect(recalled?.isError).toBe(false);
      expect(recalled?.text).toContain('the code is 42');
    });

    it('offloads a tool result over its cap into the storage, when declared', async () => {
      const { requests } = await scripted([
        { toolCalls: [{ name: 'dump', input: {} }] },
        submit({ answer: 'a' }),
      ]);
      const dump = tool({
        name: 'dump',
        description: 'Returns a large result.',
        inputSchema: z.object({}),
        callback: () => 'line of output\n'.repeat(500),
      });
      const storage = agentStorage();
      await runScripted(
        current(),
        {
          options: { model: 'claude-test', maxTokens: 1024, tools: [dump] },
          offload: { maxResultTokens: 100, previewTokens: 20 },
        },
        { storage },
      ).promise;
      expect(await storage.storage.list('offloader/')).not.toHaveLength(0);
      expect(requests[1]?.tools?.map((entry) => entry.name)).toContain(
        'retrieve_offloaded_content',
      );
      expect(toolResults(requests[1])[0]?.text.length).toBeLessThan(2_000);
    });

    it('fails EXECUTION_ERROR resuming a session it does not keep', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const failure = await failureOf(
        runScripted(
          current(),
          { resume: 'unknown' },
          { storage: agentStorage() },
        ).promise,
      );
      expect(failure.code).toBe('EXECUTION_ERROR');
      expect(failure.message).toContain('no session "unknown"');
      expect(requests).toHaveLength(0);
    });

    it('fails EXECUTION_ERROR when the storage refuses a write', async () => {
      await scripted([submit({ answer: 'a' })]);
      const inner = new InMemoryStorage();
      const refusing: Storage = {
        write: async () => {
          throw new Error('AccessDenied');
        },
        read: (key) => inner.read(key),
        delete: (key) => inner.delete(key),
        list: (query) => inner.list(query),
      };
      const failure = await failureOf(
        runScripted(current(), {}, { storage: agentStorage(refusing) }).promise,
      );
      expect(failure.code).toBe('EXECUTION_ERROR');
      expect(failure.message).toContain("the agent's storage refused a write");
      expect(failure.message).toContain('AccessDenied');
    });
  });

  describe('the storage failing', () => {
    /** Storage that fails `operation` for every key under `prefix`. */
    function failing(
      operation: 'write' | 'read' | 'list',
      prefix: string,
    ): Storage {
      const inner = new InMemoryStorage();
      const refuse = (key: string) => {
        if (key.startsWith(prefix)) throw new Error('AccessDenied');
      };
      return {
        write: async (key, data) => {
          if (operation === 'write') refuse(key);
          return inner.write(key, data);
        },
        read: async (key) => {
          if (operation === 'read') refuse(key);
          return inner.read(key);
        },
        delete: (key) => inner.delete(key),
        list: async (query) => {
          if (operation === 'list') refuse(query);
          return inner.list(query);
        },
      };
    }

    const dump = tool({
      name: 'dump',
      description: 'Returns a large result.',
      inputSchema: z.object({}),
      callback: () => 'line of output\n'.repeat(500),
    });

    it.each([
      [
        'a memory write',
        failing('write', 'memory/'),
        { memorySpace: 'notes' },
        { name: 'add_memory', input: { entries: ['x'] } },
        'write',
      ],
      [
        'a memory search',
        failing('list', 'memory/'),
        { memorySpace: 'notes' },
        { name: 'search_memory', input: { query: 'x' } },
        'list',
      ],
      [
        'an offload',
        failing('write', 'offloader/'),
        {
          options: { model: 'claude-test', maxTokens: 1024, tools: [dump] },
          offload: { maxResultTokens: 100, previewTokens: 20 },
        },
        { name: 'dump', input: {} },
        'write',
      ],
    ] as const)(
      'fails EXECUTION_ERROR for %s',
      async (_name, storage, spec, call, operation) => {
        await scripted([{ toolCalls: [call] }, submit({ answer: 'a' })]);
        const failure = await failureOf(
          runScripted(current(), spec as never, {
            storage: agentStorage(storage),
          }).promise,
        );
        expect(failure.code).toBe('EXECUTION_ERROR');
        expect(failure.message).toContain(
          `the agent's storage refused a ${operation}`,
        );
        expect(failure.message).toContain('AccessDenied');
      },
    );
  });

  describe('layers', () => {
    async function layered() {
      const root = await mkdtemp(path.join(tmpdir(), 'strands-layers-'));
      const base = path.join(root, 'agentic');
      const agent = path.join(base, 'agent');
      await mkdir(path.join(agent, '.agent/skills/summarize'), {
        recursive: true,
      });
      await writeFile(path.join(base, 'AGENTS.md'), 'BASE INSTRUCTIONS');
      await writeFile(path.join(agent, 'AGENTS.md'), 'AGENT INSTRUCTIONS');
      await writeFile(
        path.join(agent, '.agent/skills/summarize/SKILL.md'),
        '---\nname: summarize\ndescription: Summarizes a document.\n---\nSummarize it.\n',
      );
      return { base, agent };
    }

    it('composes the procedure prompt, then each layer base first, and loads skills', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const { base, agent } = await layered();
      await runScripted(
        current(),
        {
          options: {
            model: 'claude-test',
            maxTokens: 1024,
            systemPrompt: 'PROCEDURE PROMPT',
            workingDirectories: ['/mnt/work'],
          },
        },
        { layers: [base, agent] },
      ).promise;
      const system = textOf(requests[0]?.system);
      const order = [
        'PROCEDURE PROMPT',
        'BASE INSTRUCTIONS',
        'AGENT INSTRUCTIONS',
        '/mnt/work',
        STRUCTURED_OUTPUT_TOOL,
      ].map((text) => system.indexOf(text));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(system).toContain('summarize');
      expect(requests[0]?.tools?.map((tool) => tool.name)).toContain('skills');
    });

    it('composes no layer for a run that opts out', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const { base, agent } = await layered();
      await runScripted(
        current(),
        { options: { model: 'claude-test', maxTokens: 1024, layers: false } },
        { layers: [base, agent] },
      ).promise;
      expect(textOf(requests[0]?.system)).not.toContain('INSTRUCTIONS');
      expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
        'skills',
      );
    });

    it('fails when a layer instruction file cannot be read', async () => {
      const { requests } = await scripted([submit({ answer: 'a' })]);
      const root = await mkdtemp(path.join(tmpdir(), 'strands-layers-'));
      await mkdir(path.join(root, 'AGENTS.md'));
      const failure = await failureOf(
        runScripted(current(), {}, { layers: [root] }).promise,
      );
      expect(failure.code).toBe('EXECUTION_ERROR');
      expect(failure.message).toMatch(
        /instruction file .*AGENTS\.md" could not be read/,
      );
      expect(requests).toHaveLength(0);
    });
  });
});
