import {
  createSdkMcpServer,
  type HookCallback,
  type HookInput,
  type McpSdkServerConfigWithInstance,
  type ModelUsage,
  type Options,
  type SDKMessage,
  type SessionStore,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import type { S3Client } from '@aws-sdk/client-s3';
import { hash as ohash } from 'ohash';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RunRecord } from '#core/contract/task.ts';
import type { MountedFilesystem } from '../../../server/harness/filesystem/filesystem.ts';
import {
  TaskCanceled,
  TaskFailure,
} from '../../../server/harness/task-failure.ts';
import { S3SessionStore } from '../core/s3-session-store.ts';
import { CLAUDE_AGENT_SDK_VERSION } from '../core/sdk-version.ts';
import { init, result, scriptedQuery } from './__fixtures__/scripted-query.ts';
import { toAgentOptions } from './agent-options.ts';
import { AUTO_MEMORY_FRAGMENT } from './auto-memory.ts';
import {
  type AgentOptions,
  deadToolMatchers,
  matcherSelects,
  type QueryFunction,
  runAgent,
} from './kernel.ts';

const OutputSchema = z.object({ answer: z.string() });

function run(
  scripted: ReturnType<typeof scriptedQuery>,
  signal = new AbortController().signal,
) {
  const records: unknown[] = [];
  return {
    records,
    promise: runAgent(
      { prompt: 'q', output: OutputSchema, options: { maxTurns: 3 } },
      { signal, onRecord: (record) => records.push(record) },
      scripted.query,
    ),
  };
}

async function causeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TaskFailure))
    throw new Error(`expected a TaskFailure, got ${String(error)}`);
  return error.taskCause.code;
}

describe('runAgent', () => {
  it('returns the structured output, the session id and a record', async () => {
    const scripted = scriptedQuery([
      init('s-42'),
      result({ structured_output: { answer: 'yes' }, session_id: 's-42' }),
    ]);
    const { promise, records } = run(scripted);
    const agentRun = await promise;
    expect(agentRun.output).toEqual({ answer: 'yes' });
    expect(agentRun.sessionId).toBe('s-42');
    expect(records).toHaveLength(1);
    expect(agentRun.record.options).toEqual({ maxTurns: 3 });
    expect(agentRun.record).not.toHaveProperty('prompt');
    expect(agentRun.record.promptHash).toEqual(expect.any(String));
  });

  it('names the framework on its record, and keeps the usage there and on the run', async () => {
    const modelUsage = {
      'claude-haiku-4-5': { inputTokens: 10 },
    } as unknown as Record<string, ModelUsage>;
    const { promise } = run(
      scriptedQuery([
        result({ structured_output: { answer: 'yes' }, modelUsage }),
      ]),
    );
    const agentRun = await promise;
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
    };
    expect(agentRun.record).toMatchObject({
      framework: {
        name: 'claude',
        fullName: `@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`,
      },
      usage,
      rawUsage: modelUsage,
      totalCostUsd: 0.01,
    });
    expect(agentRun.record).not.toHaveProperty('modelUsage');
    expect(agentRun.usage).toEqual(usage);
    expect(agentRun.rawUsage).toEqual(modelUsage);
  });

  it('refuses an agent contract whose root is not an object, before the run', async () => {
    const scripted = scriptedQuery([]);
    await expect(
      runAgent(
        { prompt: 'q', output: z.array(z.string()) },
        { signal: new AbortController().signal, onRecord: () => undefined },
        scripted.query,
      ),
    ).rejects.toThrow(/wrapNonObjectOutput/);
    expect(scripted.calls).toHaveLength(0);
  });

  it('fails before the run when a context block’s file cannot be read, naming it', async () => {
    const scripted = scriptedQuery([]);
    await expect(
      runAgent(
        {
          prompt: [{ tag: 'protocol', filepath: 'missing-fragment.md' }, 'q'],
          output: OutputSchema,
        },
        { signal: new AbortController().signal, onRecord: () => undefined },
        scripted.query,
      ),
    ).rejects.toThrow(/"missing-fragment.md" could not be read/);
    expect(scripted.calls).toHaveLength(0);
  });

  it('sends an opted-in non-object root wrapped, and returns it unwrapped', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { output: ['a', 'b'] } }),
    ]);
    const agentRun = await runAgent(
      { prompt: 'q', output: z.array(z.string()), wrapNonObjectOutput: true },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    expect(agentRun.output).toEqual(['a', 'b']);
    expect(scripted.calls[0]?.options.outputFormat).toMatchObject({
      schema: { type: 'object', required: ['output'] },
    });
  });

  it("gives a run a fresh AgentForge server while another run holds the one in its options, and a consumer's own as it is", async () => {
    const vault: MountedFilesystem = {
      localPath: '/workspace/vault',
      permissions: [{ action: 'read', glob: '**' }],
      path: (relativePath) => relativePath,
      writablePath: (relativePath) => relativePath,
      push: async () => ({ files: [] }),
    };
    const derived = toAgentOptions({ vault });
    const held = derived.mcpServers
      ?.agentforge as McpSdkServerConfigWithInstance;
    const own = createSdkMcpServer({ name: 'own' });
    const transport = () => ({
      start: async () => {},
      send: async () => {},
      close: async () => {},
    });
    await held.instance.connect(transport() as never);
    await own.instance.connect(transport() as never);
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'x' } }),
    ]);
    await runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        options: { mcpServers: { ...derived.mcpServers, own } },
      },
      { signal: new AbortController().signal, onRecord: () => {} },
      scripted.query,
    );
    const given = scripted.calls[0]?.options.mcpServers as Record<
      string,
      McpSdkServerConfigWithInstance
    >;
    expect(given.agentforge?.instance).not.toBe(held.instance);
    expect(given.agentforge?.instance.isConnected()).toBe(false);
    expect(given.own).toBe(own);
    await held.instance.close();
    await own.instance.close();
  });

  it('switches background work off and sets the output format', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'x' } }),
    ]);
    await run(scripted).promise;
    const options = scripted.calls[0]?.options as {
      env: Record<string, string>;
      outputFormat: { type: string };
    };
    expect(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(options.outputFormat.type).toBe('json_schema');
  });

  it('gives the CLI the subscription’s credential, not an API key beside it', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth');
    vi.stubEnv('ANTHROPIC_API_KEY', 'strands-key');
    try {
      const scripted = scriptedQuery([
        result({ structured_output: { answer: 'x' } }),
      ]);
      await run(scripted).promise;
      const options = scripted.calls[0]?.options as {
        env: Record<string, string | undefined>;
      };
      expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('auto memory', () => {
    const MEMORY_DIRECTORY = '/workspace/memories/spaces/a';
    const FRAGMENT = AUTO_MEMORY_FRAGMENT.render({
      prompt: 'q',
      output: OutputSchema,
      memoryDirectory: MEMORY_DIRECTORY,
    });

    async function runWith(options: AgentOptions, memoryDirectory?: string) {
      const scripted = scriptedQuery([
        result({ structured_output: { answer: 'x' } }),
      ]);
      const logged: string[] = [];
      const log = vi
        .spyOn(console, 'log')
        .mockImplementation((line: string) => logged.push(line));
      try {
        const agentRun = await runAgent(
          {
            prompt: 'q',
            output: OutputSchema,
            options,
            ...(memoryDirectory === undefined ? {} : { memoryDirectory }),
          },
          { signal: new AbortController().signal, onRecord: () => undefined },
          scripted.query,
        );
        const prompt = logged
          .map((line) => JSON.parse(line) as { event: string })
          .find(({ event }) => event === 'agentforge.prompt') as {
          systemPrompt?: unknown;
        };
        return {
          agentRun,
          prompt,
          options: scripted.calls[0]?.options as Options & {
            env: Record<string, string | undefined>;
          },
        };
      } finally {
        log.mockRestore();
      }
    }

    it('points a run that declares a directory at it, with its instructions after the procedure’s own', async () => {
      vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1');
      try {
        const { agentRun, prompt, options } = await runWith(
          {
            systemPrompt: 'own',
            settings: {
              permissions: { blockReadsOutsideWorkingDirectories: true },
            },
          },
          MEMORY_DIRECTORY,
        );
        expect(options.settings).toEqual({
          permissions: { blockReadsOutsideWorkingDirectories: true },
          autoMemoryEnabled: true,
          autoMemoryDirectory: MEMORY_DIRECTORY,
        });
        expect(options.systemPrompt).toEqual(['own', FRAGMENT]);
        // The container's own variable would turn the declared memory off.
        expect(options.env).not.toHaveProperty(
          'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        );
        expect(prompt.systemPrompt).toEqual(['own', FRAGMENT]);
        expect(agentRun.record.options.systemPrompt).toBe(
          ohash(['own', FRAGMENT]),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('turns auto memory off for a run that declares none, its prompt its own', async () => {
      const { agentRun, prompt, options } = await runWith({
        systemPrompt: 'own',
      });
      expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(options.settings).toBeUndefined();
      expect(options.systemPrompt).toBe('own');
      expect(prompt.systemPrompt).toBe('own');
      expect(agentRun.record.options.systemPrompt).toBe(ohash('own'));
    });

    it.each<[string, AgentOptions, string | undefined, RegExp]>([
      [
        'a relative directory',
        {},
        'memories',
        /not an absolute directory: "memories"/,
      ],
      [
        'the preset',
        { systemPrompt: { type: 'preset', preset: 'claude_code' } },
        MEMORY_DIRECTORY,
        /"claude_code" system prompt preset/,
      ],
      [
        'its own autoMemoryEnabled',
        { settings: { autoMemoryEnabled: false } },
        undefined,
        /sets `autoMemoryEnabled` in its settings: declare `memoryDirectory`/,
      ],
      [
        'its own autoMemoryDirectory',
        { settings: { autoMemoryDirectory: '/elsewhere' } },
        MEMORY_DIRECTORY,
        /sets `autoMemoryDirectory` in its settings/,
      ],
      [
        'its own variable',
        { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } },
        undefined,
        /sets CLAUDE_CODE_DISABLE_AUTO_MEMORY in its env/,
      ],
      [
        'settings in a file',
        { settings: '/etc/claude/settings.json' },
        MEMORY_DIRECTORY,
        /settings are the file "\/etc\/claude\/settings.json"/,
      ],
    ])(
      'refuses %s before the run, EXECUTION_ERROR',
      async (_label, options, memoryDirectory, message) => {
        const scripted = scriptedQuery([]);
        const promise = runAgent(
          {
            prompt: 'q',
            output: OutputSchema,
            options,
            ...(memoryDirectory === undefined ? {} : { memoryDirectory }),
          },
          { signal: new AbortController().signal, onRecord: () => undefined },
          scripted.query,
        );
        await expect(promise).rejects.toThrow(message);
        expect(await causeOf(promise)).toBe('EXECUTION_ERROR');
        expect(scripted.calls).toHaveLength(0);
      },
    );
  });

  describe('with a session store', () => {
    const ASSISTANT = {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: { role: 'assistant', content: [] },
    } as unknown as SDKMessage;
    const KEY = { projectKey: 'project', sessionId: 'session-1' };

    /** The SDK's mirror, reduced to appending these entries as the run starts. */
    function mirroring(
      scripted: ReturnType<typeof scriptedQuery>,
      entries: SessionStoreEntry[],
    ): QueryFunction {
      return ((parameters: Parameters<QueryFunction>[0]) => {
        void parameters.options?.sessionStore?.append(KEY, entries);
        return scripted.query(parameters);
      }) as QueryFunction;
    }

    function storeOf(appended: SessionStoreEntry[][]): SessionStore {
      return {
        append: async (_key, entries) => {
          appended.push(entries);
        },
        load: async () => null,
      };
    }

    const answered = () =>
      scriptedQuery([
        ASSISTANT,
        result({ structured_output: { answer: 'x' } }),
      ]);
    const ENTRIES = [{ type: 'assistant', uuid: 'assistant-1' }];

    it("mirrors to the deployment's store, unless the procedure names its own", async () => {
      const deployed: SessionStoreEntry[][] = [];
      const own: SessionStoreEntry[][] = [];
      const context = {
        signal: new AbortController().signal,
        onRecord: () => {},
        sessionStore: storeOf(deployed),
      };
      await runAgent(
        { prompt: 'q', output: OutputSchema },
        context,
        mirroring(answered(), ENTRIES),
      );
      expect(deployed).toEqual([ENTRIES]);
      await runAgent(
        {
          prompt: 'q',
          output: OutputSchema,
          options: { sessionStore: storeOf(own) },
        },
        context,
        mirroring(answered(), ENTRIES),
      );
      expect(own).toEqual([ENTRIES]);
      expect(deployed).toHaveLength(1);
    });

    it("records where the deployment's store keeps the transcript, and nothing for a procedure's own", async () => {
      const records: RunRecord[] = [];
      const deployed = new S3SessionStore({
        bucket: 'sessions',
        prefix: 'writer',
        client: { send: async () => ({}) } as unknown as S3Client,
      });
      const context = {
        signal: new AbortController().signal,
        onRecord: (record: RunRecord) => records.push(record),
        sessionStore: deployed,
      };
      await runAgent(
        { prompt: 'q', output: OutputSchema },
        context,
        mirroring(answered(), ENTRIES),
      );
      await runAgent(
        {
          prompt: 'q',
          output: OutputSchema,
          options: { sessionStore: storeOf([]) },
        },
        context,
        mirroring(answered(), ENTRIES),
      );
      expect(records.map((record) => record.transcript)).toEqual([
        { bucket: 'sessions', agent: 'writer', projectKey: 'project' },
        undefined,
      ]);
    });

    it('fails the run when an assistant message never reached the store', async () => {
      const context = {
        signal: new AbortController().signal,
        onRecord: () => {},
        sessionStore: storeOf([]),
      };
      expect(
        await causeOf(
          runAgent(
            { prompt: 'q', output: OutputSchema },
            context,
            mirroring(answered(), []),
          ),
        ),
      ).toBe('EXECUTION_ERROR');
    });

    it('reports why a run with no result ended, not the mirror it cut short', async () => {
      const context = {
        signal: new AbortController().signal,
        onRecord: () => {},
        sessionStore: storeOf([]),
      };
      const crashed = scriptedQuery([ASSISTANT], {
        crash: new Error('connection lost'),
      });
      await expect(
        runAgent(
          { prompt: 'q', output: OutputSchema },
          context,
          mirroring(crashed, []),
        ),
      ).rejects.toThrow(
        'the run ended without a result: Error: connection lost',
      );
    });
  });

  it('takes the first result and logs a later one it ignores', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'first' } }),
      result({ structured_output: { answer: 'second' } }),
    ]);
    expect((await run(scripted).promise).output).toEqual({ answer: 'first' });
    expect(logged).toHaveBeenCalledWith(
      'a result after the first is not the outcome, and is ignored',
      expect.objectContaining({ structured_output: { answer: 'second' } }),
    );
    logged.mockRestore();
  });

  it.each([
    [
      'success with no structured output',
      result({ structured_output: undefined, result: 'prose' }),
      'OUTPUT_INVALID',
    ],
    [
      'non-conforming structured output',
      result({ structured_output: { answer: 7 } }),
      'OUTPUT_INVALID',
    ],
    [
      'maxTurns',
      result({ subtype: 'error_max_turns', is_error: true }),
      'BUDGET_EXHAUSTED',
    ],
    [
      'maxBudgetUsd',
      result({ subtype: 'error_max_budget_usd', is_error: true }),
      'BUDGET_EXHAUSTED',
    ],
    [
      'a 429',
      result({ is_error: true, api_error_status: 429, result: 'limited' }),
      'USAGE_LIMITED',
    ],
    [
      'a 401',
      result({ is_error: true, api_error_status: 401, result: 'no' }),
      'CREDENTIAL_EXPIRED',
    ],
    [
      'a 529',
      result({ is_error: true, api_error_status: 529, result: 'busy' }),
      'PROVIDER_TRANSIENT',
    ],
    [
      'anything else',
      result({
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['boom'],
      }),
      'EXECUTION_ERROR',
    ],
  ])('classifies %s', async (_name, message, code) => {
    expect(await causeOf(run(scriptedQuery([message])).promise)).toBe(code);
  });

  it.each([
    [
      result({ subtype: 'error_max_turns', is_error: true }),
      'Raise `maxTurns` or `maxBudgetUsd` for the procedure, or narrow what the prompt asks for.',
    ],
    [
      result({ is_error: true, api_error_status: 429, result: 'limited' }),
      "Retry after `retryAfter`, when the subscription's usage limit resets.",
    ],
    [
      result({ is_error: true, api_error_status: 401, result: 'no' }),
      "An operator renews the subscription token (`claude setup-token`) and updates the agent's secret; a retry cannot succeed before that (§REQ714).",
    ],
  ])('suggests the Claude action for its cause', async (message, suggested) => {
    const error = await run(scriptedQuery([message])).promise.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TaskFailure);
    expect((error as TaskFailure).taskCause.suggestedAction).toBe(suggested);
  });

  it('fails when the stream ends with no result', async () => {
    expect(await causeOf(run(scriptedQuery([init()])).promise)).toBe(
      'EXECUTION_ERROR',
    );
  });

  it('interrupts on cancel and reports the task cancelled', async () => {
    const scripted = scriptedQuery([init()], { hang: true });
    const controller = new AbortController();
    const { promise } = run(scripted, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(TaskCanceled);
    expect(scripted.interrupted()).toBe(true);
  });

  it('reports a cancel that arrives while the prompt is read, and never starts the run', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'unwanted' } }),
    ]);
    const controller = new AbortController();
    const { promise } = run(scripted, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(TaskCanceled);
    expect(scripted.calls).toHaveLength(0);
  });

  it("ends the session when the kernel's own code throws mid-run", async () => {
    const scripted = scriptedQuery([init()], { hang: true });
    const promise = runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        options: {
          hooks: { PreToolUse: [{ matcher: '(', hooks: [async () => ({})] }] },
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    await expect(promise).rejects.toThrow(/Invalid regular expression/);
    expect(scripted.closed()).toBe(true);
  });
});

describe('hook matchers', () => {
  it('evaluates a matcher as Claude Code does', () => {
    expect(matcherSelects(undefined, 'Bash')).toBe(true);
    expect(matcherSelects('*', 'Bash')).toBe(true);
    expect(matcherSelects('Edit|Write', 'Write')).toBe(true);
    expect(matcherSelects('Edit, Write', 'Write')).toBe(true);
    // Exact characters only: compared whole, never as a prefix.
    expect(matcherSelects('mcp__memory', 'mcp__memory__create_entities')).toBe(
      false,
    );
    // Any other character: an unanchored regular expression.
    expect(
      matcherSelects('mcp__memory__.*', 'mcp__memory__create_entities'),
    ).toBe(true);
    expect(matcherSelects('Edit.*', 'NotebookEdit')).toBe(true);
  });

  it('names each tool-event matcher that selects no tool', () => {
    const hook = { hooks: [async () => ({})] };
    expect(
      deadToolMatchers(
        {
          PreToolUse: [
            { ...hook, matcher: 'Bash' },
            { ...hook, matcher: 'StructuredOuput' },
          ],
          Stop: [{ ...hook, matcher: 'anything' }],
        },
        ['Bash', 'StructuredOutput'],
      ),
    ).toEqual(['PreToolUse "StructuredOuput"']);
  });

  it('fails the run before its first turn when a guardrail would never fire', async () => {
    const scripted = scriptedQuery([
      init(),
      result({ structured_output: { answer: 'unguarded' } }),
    ]);
    const promise = runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        options: {
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({})] }],
          },
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    await expect(promise).rejects.toThrow(/PreToolUse "Bash"/);
  });
});

describe('structured output validation', () => {
  /**
   * A stand-in for the CLI: the agent submits once, the kernel's validation
   * runs, and the run stops once the kernel aborts it or ends with `final`.
   */
  function submittingQuery(final: SDKMessage): QueryFunction {
    return ((parameters: { options: Options }) => {
      async function* stream(): AsyncGenerator<SDKMessage, void> {
        yield init();
        const entries = parameters.options.hooks?.PreToolUse ?? [];
        const hook = entries.at(-1)?.hooks[0] as HookCallback;
        await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'StructuredOutput',
            tool_input: { answer: 'yes' },
          } as unknown as HookInput,
          'tool-1',
          { signal: new AbortController().signal },
        );
        if (parameters.options.abortController?.signal.aborted) {
          throw new Error('aborted');
        }
        yield final;
      }
      return Object.assign(stream(), {
        interrupt: async () => undefined,
        close: () => undefined,
      });
    }) as unknown as QueryFunction;
  }

  it('is on every run, after the procedure’s own PreToolUse hooks', async () => {
    const own = { matcher: 'StructuredOutput', hooks: [async () => ({})] };
    const scripted = scriptedQuery([
      init(),
      result({ structured_output: { answer: 'yes' } }),
    ]);
    await runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        options: { hooks: { PreToolUse: [own] } },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    const hooks = scripted.calls[0]?.options.hooks as Options['hooks'];
    expect(hooks?.PreToolUse).toEqual([
      own,
      { matcher: 'StructuredOutput', hooks: [expect.any(Function)] },
    ]);
  });

  it('fails the run with the last refusal when the attempts run out', async () => {
    const promise = run(
      scriptedQuery([
        init(),
        result({
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: [
            'Failed to provide valid structured output after 5 attempts — last StructuredOutput error: Write kata.md before submitting.',
          ],
        }),
      ]),
    ).promise;
    await expect(promise).rejects.toMatchObject({
      taskCause: {
        code: 'OUTPUT_INVALID',
        message: expect.stringMatching(/Write kata\.md before submitting/),
      },
    });
  });

  it('fails the run with the last refusal when the agent gives up rather than submit again', async () => {
    const promise = runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        guardrails: {
          stop: [async () => ({ reason: 'Write kata.md before submitting.' })],
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      submittingQuery(result({ result: 'I cannot answer that.' })),
    );
    await expect(promise).rejects.toMatchObject({
      taskCause: {
        code: 'OUTPUT_INVALID',
        message: expect.stringMatching(
          /without accepted structured output; the last was refused: .*Write kata\.md before submitting/s,
        ),
        payload: 'I cannot answer that.',
      },
    });
  });

  it('ends the run when a stop guard throws, naming its error', async () => {
    const query = submittingQuery(
      result({ structured_output: { answer: 'yes' } }),
    );
    const promise = runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        guardrails: {
          stop: [
            async () => {
              throw new Error('the guard broke');
            },
          ],
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      query,
    );
    await expect(promise).rejects.toMatchObject({
      taskCause: {
        code: 'EXECUTION_ERROR',
        message: expect.stringMatching(/a stop guard threw .*the guard broke/),
      },
    });
  });
});
