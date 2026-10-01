import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '#core/contract/task.ts';
import { DISTILL_OVERAGE_ALLOWANCE, distill } from './distill.ts';
import { type AgentRunSpec, TaskFailure } from './kernel.ts';

function runAgentAnswering(distillation: string) {
  return vi.fn(async (spec: AgentRunSpec<unknown>) => ({
    output: spec.output.parse({ distillation }),
    sessionId: 'session-1',
    record: {} as RunRecord,
  })) as unknown as ReturnType<typeof vi.fn> &
    (<Output>(spec: AgentRunSpec<Output>) => Promise<{
      output: Output;
      sessionId: string;
      record: RunRecord;
    }>);
}

const SMALL = [
  { source: 'research/2026-08.md', content: 'August: prices rose.' },
  { source: 'research/2026-09.md', content: 'September: prices fell.' },
];

describe('distill', () => {
  it('returns documents within the cap unchanged, one block each, with no run', async () => {
    const runAgent = runAgentAnswering('unused');
    expect(
      await distill({ runAgent }, { documents: SMALL, instruction: 'prices' }),
    ).toEqual([
      {
        tag: 'document',
        source: 'research/2026-08.md',
        context: 'August: prices rose.',
      },
      {
        tag: 'document',
        source: 'research/2026-09.md',
        context: 'September: prices fell.',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('distills documents over the cap in one utility run, the instruction last', async () => {
    const runAgent = runAgentAnswering(
      'Prices rose then fell (research/2026-08.md#L1, research/2026-09.md#L1).',
    );
    const blocks = await distill(
      { runAgent },
      {
        documents: [
          { source: 'a.md', content: 'line one\nline two' },
          { source: 'b.md', content: 'x'.repeat(200) },
        ],
        instruction: 'what moved prices',
        capTokens: 20,
        model: 'sonnet',
      },
    );
    expect(blocks).toEqual([
      {
        tag: 'distillation',
        description: 'what moved prices',
        sources: 2,
        context:
          'Prices rose then fell (research/2026-08.md#L1, research/2026-09.md#L1).',
      },
    ]);
    expect(runAgent).toHaveBeenCalledOnce();
    const spec = runAgent.mock.calls[0]?.[0] as AgentRunSpec<unknown>;
    expect(spec.options).toMatchObject({
      model: 'sonnet',
      tools: [],
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 3,
      systemPrompt: expect.stringMatching(/source#Lnn/),
    });
    const prompt = spec.prompt as readonly unknown[];
    expect(prompt[0]).toMatchObject({
      tag: 'document',
      source: 'a.md',
      context: '1\tline one\n2\tline two',
    });
    expect(prompt.at(-1)).toMatch(
      /^Distill the documents above for this purpose: what moved prices/,
    );
  });

  it('passes a distillation within its allowance, and fails one past it, carrying it', async () => {
    const capTokens = 10;
    const documents = [{ source: 'a.md', content: 'x'.repeat(200) }];
    const atAllowance = 'y'.repeat(capTokens * DISTILL_OVERAGE_ALLOWANCE * 4);
    expect(
      await distill(
        { runAgent: runAgentAnswering(atAllowance) },
        { documents, instruction: 'all', capTokens },
      ),
    ).toMatchObject([{ tag: 'distillation', context: atAllowance }]);

    const pastAllowance = `${atAllowance}yyyy`;
    const failure = await distill(
      { runAgent: runAgentAnswering(pastAllowance) },
      { documents, instruction: 'all', capTokens },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskFailure);
    expect((failure as TaskFailure).taskCause).toMatchObject({
      code: 'OUTPUT_INVALID',
      message: expect.stringMatching(
        /its cap is 10, and at most 15 is allowed/,
      ),
      payload: pastAllowance,
    });
  });

  it('returns nothing for no documents, and refuses a cap that is not a positive whole number', async () => {
    const runAgent = runAgentAnswering('unused');
    expect(
      await distill({ runAgent }, { documents: [], instruction: 'x' }),
    ).toEqual([]);
    for (const capTokens of [0, -5, 1.5]) {
      await expect(
        distill(
          { runAgent },
          { documents: SMALL, instruction: 'x', capTokens },
        ),
      ).rejects.toThrow(/positive whole number/);
    }
    expect(runAgent).not.toHaveBeenCalled();
  });
});
