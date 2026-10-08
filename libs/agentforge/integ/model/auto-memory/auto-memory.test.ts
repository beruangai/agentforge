/**
 * A run's auto memory (§REQ404) through `runAgent`, against a real model.
 * Claude Code honouring `autoMemoryDirectory` from the SDK's settings,
 * AgentForge's own instructions making the agent save without the preset,
 * the directory staying readable under the read fence though it is not a
 * working directory, and the variable turning memory off are all
 * undocumented as a combination, and can change with a CLI release
 * (docs/research/claude-agent-sdk.md).
 *
 * Every run is fenced, as a generated project's are. What is asserted holds
 * whichever way the model words its memory: a file and an index line exist,
 * and the fact comes back.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  type AgentOptions,
  type QueryFunction,
  runAgent,
} from '../../../src/server/harness/kernel.ts';
import {
  createSandbox,
  createSubscriptionEnvironment,
} from '../../__fixtures__/claude-agent-sdk.ts';

const MODEL = 'claude-haiku-4-5';
const CODENAME = 'BLUE-HERON-42';

/** The SDK's `query()`, reporting where the session's auto memory is from its `init`. */
function observingMemoryPaths(memoryPaths: unknown[]): QueryFunction {
  return ((parameters: Parameters<QueryFunction>[0]) => {
    const session = query(parameters);
    const iterate = session[Symbol.asyncIterator].bind(session);
    return Object.assign(session, {
      async *[Symbol.asyncIterator]() {
        for await (const message of { [Symbol.asyncIterator]: iterate }) {
          if (message.type === 'system' && message.subtype === 'init') {
            memoryPaths.push(
              (message as SDKMessage & { memory_paths?: unknown }).memory_paths,
            );
          }
          yield message;
        }
      },
    });
  }) as QueryFunction;
}

describe('auto memory', () => {
  it('saves a fact to the declared directory, and a later run recalls it, fenced and outside its working directories', async () => {
    const sandbox = createSandbox('auto-memory');
    onTestFinished(() => sandbox.dispose());
    const memoryDirectory = join(
      realpathSync(join(sandbox.workingDirectory, '..')),
      'memory',
    );
    mkdirSync(memoryDirectory);
    const fenced = (options: AgentOptions): AgentOptions => ({
      cwd: sandbox.workingDirectory,
      env: createSubscriptionEnvironment(sandbox.configDirectory),
      model: MODEL,
      settingSources: [],
      permissionMode: 'dontAsk',
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
      maxTurns: 10,
      ...options,
    });
    const memoryPaths: unknown[] = [];

    await runAgent(
      {
        prompt: `Remember this for all future tasks: the deploy codename for this project is ${CODENAME}, chosen because the release team names deploys after birds. Then submit \`saved: true\`.`,
        output: z.object({ saved: z.boolean() }),
        memoryDirectory,
        options: fenced({ tools: ['Read', 'Write', 'Edit'] }),
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      observingMemoryPaths(memoryPaths),
    );
    const files = readdirSync(memoryDirectory);
    expect(files).toContain('MEMORY.md');
    const topics = files.filter((file) => file !== 'MEMORY.md');
    expect(topics.length).toBeGreaterThan(0);
    const index = readFileSync(join(memoryDirectory, 'MEMORY.md'), 'utf8');
    expect(topics.some((topic) => index.includes(`(${topic})`))).toBe(true);

    const recalled = await runAgent(
      {
        prompt:
          'What is the deploy codename for this project? Answer from what you already know. If you do not know, answer "unknown".',
        output: z.object({ codename: z.string() }),
        memoryDirectory,
        options: fenced({ tools: [] }),
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      observingMemoryPaths(memoryPaths),
    );
    expect(recalled.output.codename).toContain(CODENAME);
    const declared = expect.objectContaining({
      auto: expect.stringContaining(memoryDirectory),
    });
    expect(memoryPaths).toEqual([declared, declared]);
  });

  it('keeps no memory for a run that declares none', async () => {
    const sandbox = createSandbox('auto-memory-none');
    onTestFinished(() => sandbox.dispose());
    const memoryPaths: unknown[] = [];
    await runAgent(
      {
        prompt: 'What is two plus two? Answer in digits.',
        output: z.object({ answer: z.string() }),
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: MODEL,
          settingSources: [],
          tools: [],
          maxTurns: 3,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      observingMemoryPaths(memoryPaths),
    );
    expect(memoryPaths).toHaveLength(1);
    expect(
      (memoryPaths[0] as { auto?: unknown } | undefined)?.auto,
    ).toBeUndefined();
  });
});
