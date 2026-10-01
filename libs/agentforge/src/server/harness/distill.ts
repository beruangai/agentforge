import { z } from 'zod';
import { cause } from '#core/contract/task.ts';
import { TaskFailure } from './kernel.ts';
import type { ContextBlock } from './prompt.ts';
import type { TaskContext } from './task-process.ts';

export interface DistillDocument {
  /** Names the document in citations: a file path, a URL, an id. */
  readonly source: string;
  readonly content: string;
}

export interface DistillSpec {
  readonly documents: readonly DistillDocument[];
  /** What the next run needs from them; the distillation keeps that. */
  readonly instruction: string;
  /** Estimated tokens, as characters over four; 12 000 by default. A distillation may run to 1.5×. */
  readonly capTokens?: number;
  /** `haiku` by default. */
  readonly model?: string;
}

export const DEFAULT_DISTILL_CAP_TOKENS = 12_000;
/** How far over its cap a distillation may run before it fails rather than being passed on. */
export const DISTILL_OVERAGE_ALLOWANCE = 1.5;
const DEFAULT_DISTILL_MODEL = 'haiku';
const DISTILL_MAX_TURNS = 3;

const DistillationSchema = z.strictObject({
  distillation: z.string().min(1),
});

/** Tokens estimated as characters over four: an estimate by contract, not a count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Documents as context for a run, within a token cap (§REQ209): returned
 * unchanged, one block each, when they fit; otherwise compacted by one
 * utility run of the procedure's own — no tools, no `.claude/` layer, the
 * small model — into one block that cites what it keeps by source and line.
 * The utility run is an ordinary run: cancelled with the task, recorded on it.
 */
export async function distill(
  context: Pick<TaskContext, 'runAgent'>,
  spec: DistillSpec,
): Promise<readonly ContextBlock[]> {
  const capTokens = spec.capTokens ?? DEFAULT_DISTILL_CAP_TOKENS;
  if (!Number.isInteger(capTokens) || capTokens <= 0) {
    throw new Error(
      `distill's capTokens is a positive whole number of tokens, not ${capTokens}`,
    );
  }
  if (spec.documents.length === 0) return [];
  const estimated = estimateTokens(
    spec.documents.map((document) => document.content).join(''),
  );
  if (estimated <= capTokens) {
    return spec.documents.map((document) => ({
      tag: 'document',
      source: document.source,
      context: document.content,
    }));
  }
  const run = await context.runAgent({
    prompt: [
      ...spec.documents.map((document) => ({
        tag: 'document',
        source: document.source,
        description: 'Each line is prefixed with its line number and a tab.',
        context: numbered(document.content),
      })),
      `Distill the documents above for this purpose: ${spec.instruction}\n\nKeep the distillation under about ${capTokens} tokens (${capTokens * 4} characters).`,
    ],
    output: DistillationSchema,
    options: {
      model: spec.model ?? DEFAULT_DISTILL_MODEL,
      systemPrompt: DISTILL_SYSTEM_PROMPT,
      tools: [],
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: DISTILL_MAX_TURNS,
    },
  });
  const { distillation } = run.output;
  const distilledTokens = estimateTokens(distillation);
  const allowed = Math.floor(capTokens * DISTILL_OVERAGE_ALLOWANCE);
  if (distilledTokens > allowed) {
    throw new TaskFailure(
      cause(
        'OUTPUT_INVALID',
        `the distillation is about ${distilledTokens} tokens: its cap is ${capTokens}, and at most ${allowed} is allowed`,
        { payload: distillation },
      ),
    );
  }
  return [
    {
      tag: 'distillation',
      description: spec.instruction,
      sources: spec.documents.length,
      context: distillation,
    },
  ];
}

function numbered(content: string): string {
  return content
    .split('\n')
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
}

const DISTILL_SYSTEM_PROMPT = `You distill documents into a compact, faithful brief for another agent, which will rely on it in place of the documents.

- Keep only what the stated purpose needs, as the documents state it. Never infer, generalise or add anything the documents do not say.
- Prefer facts, figures, decisions and their reasons over narrative. Merge what repeats; keep what conflicts, saying where.
- Cite every fact you keep as \`source#Lnn\` (or \`source#Lnn-Lmm\`), using the document's source and the line numbers shown.
- Stay within the length you are given.`;
