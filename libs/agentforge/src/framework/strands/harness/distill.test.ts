import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '#core/contract/task.ts';
import { DISTILL_MAX_TURNS } from '../../../server/harness/distill.ts';
import { runScripted, submit } from './__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  scriptedAnthropic,
} from './__fixtures__/scripted-anthropic.ts';
import { DEFAULT_DISTILL_MODEL, distill } from './distill.ts';
import type { AgentRun, AgentRunSpec } from './types.ts';

function runAgentAnswering(distillation: string) {
  return vi.fn(async (spec: AgentRunSpec<unknown>) => ({
    output: spec.output.parse({ distillation }),
    sessionId: 'session-1',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    rawUsage: {} as AgentRun<unknown>['rawUsage'],
    record: {} as RunRecord,
  })) as unknown as ReturnType<typeof vi.fn> &
    (<Output>(spec: AgentRunSpec<Output>) => Promise<AgentRun<Output>>);
}

const OVER = [{ source: 'a.md', content: 'x'.repeat(400) }];

describe('distill', () => {
  it('distills in a utility run: Haiku, no layers, no tools, a few turns', async () => {
    const runAgent = runAgentAnswering('short (a.md#L1)');
    await distill(
      { runAgent },
      { documents: OVER, instruction: 'gist', capTokens: 10 },
    );
    expect(runAgent).toHaveBeenCalledOnce();
    const [spec] = runAgent.mock.calls[0] as [AgentRunSpec<unknown>];
    expect(spec.options).toMatchObject({
      model: DEFAULT_DISTILL_MODEL,
      layers: false,
      limits: { turns: DISTILL_MAX_TURNS },
    });
    expect(spec.options?.systemPrompt).toEqual(expect.any(String));
    expect(spec.options?.tools).toBeUndefined();
  });

  it('runs on the model the spec names', async () => {
    const runAgent = runAgentAnswering('short (a.md#L1)');
    await distill(
      { runAgent },
      {
        documents: OVER,
        instruction: 'gist',
        capTokens: 10,
        model: 'claude-sonnet-5-5',
      },
    );
    const [spec] = runAgent.mock.calls[0] as [AgentRunSpec<unknown>];
    expect(spec.options?.model).toBe('claude-sonnet-5-5');
  });
});

describe('distill, through the runner', () => {
  let api: ScriptedAnthropic | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it('distills in one run with no tool but its structured output and no layer, the instruction last', async () => {
    const scripted = await scriptedAnthropic([
      submit({ distillation: 'The gist (a.md#L1).' }),
    ]);
    api = scripted;
    const runAgent = <Output>(spec: AgentRunSpec<Output>) =>
      runScripted(scripted, spec, { layers: ['/nonexistent'] }).promise;
    const blocks = await distill(
      { runAgent },
      { documents: OVER, instruction: 'the gist', capTokens: 10 },
    );
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks[0])).toContain('The gist (a.md#L1).');
    const [request] = scripted.requests;
    expect(request?.model).toBe(DEFAULT_DISTILL_MODEL);
    expect(request?.tools?.map((entry) => entry.name)).toEqual([
      'strands_structured_output',
    ]);
    const prompt = JSON.stringify(request?.messages[0]?.content);
    expect(prompt.lastIndexOf('the gist')).toBeGreaterThan(
      prompt.indexOf('a.md'),
    );
  });
});
