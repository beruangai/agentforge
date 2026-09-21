/**
 * DESIGN_OPTIONS §N — the baseline set of procedures.
 *
 * Inferred from BOTH consumers' contracts, specs and code, read on 2026-09-22:
 *   ~/workspace/beruangai/StrategyFoundry/docs/AGENTFORGE_CONTRACT.md  (H1–H25)
 *   ~/workspace/PlayTek/trendbot-monorepo/docs/AGENTFORGE_CONTRACT.md  (T1–T44)
 *
 * Representative, not exhaustive: enough shapes to expose the differences
 * between the candidate authoring styles, per §N's exit condition. Consumer
 * domain vocabulary is deliberately absent (ARCHITECTURE.md §11) — the shapes
 * are borrowed, the nouns are not.
 *
 * The five shapes, and what each one is here to stress:
 *
 *   1  minimal        the floor. Name, outer contract, agent contract, marshal,
 *                     prompt, options.                            (H1, H2, T1)
 *   2  computed       outer output carries fields the model must never be asked
 *                     for; the marshal step adds them.          (H-p3, T18, D2)
 *   3  phased         before / after-success / after-failure side effects, each
 *                     receiving the prior attempt's state.        (T33, T34, D33)
 *   4  guarded        guardrails composed from several sources, additively, with
 *                     no merge dropping one.                     (H5, T8–T11, D8)
 *   5  discriminated  a domain-level negative result returned as a SUCCESS under
 *                     its own discriminator, not an error.              (T19)
 *
 * Deliberately NOT in the baseline, and why:
 *
 *   - **A procedure that invokes no agent** (TrendBot T4). `ARCHITECTURE.md` §11
 *     excludes these: "AgentForge runs agents; a consumer's plain work belongs
 *     in the consumer". T4 asks for them explicitly, so this is a live conflict
 *     between a consumer contract and an accepted decision, and it is RAISED
 *     rather than designed around. See the findings note.
 *   - **Pausing for a human** — §M, operator-level, neither consumer requires it.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// The kit every style is written against. Same types, three surfaces.
// ---------------------------------------------------------------------------

/** What a caller sends and receives. Zod only — a worker imports this. */
export type Contract<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> = {
  readonly name: string;
  readonly input: Input;
  readonly output: Output;
};

export function contract<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  name: string,
  input: Input,
  output: Output,
): Contract<Input, Output> {
  return { name, input, output };
}

/** The SDK's own option type, narrowed to what the baseline exercises. */
export type RunOptions = {
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
  readonly cwd?: string;
  readonly systemPrompt?: string;
};

/** A guardrail contributes hooks additively; replacing is explicit (D8). */
export type Guardrail = {
  readonly label: string;
  readonly kind: 'writeScope' | 'stopGuard' | 'disclosure';
  readonly matcher: string;
};

export type PriorAttempt = 'NONE' | 'FAILED' | 'CANCELLED' | 'LOST';

export type PhaseContext = {
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly priorAttempt: PriorAttempt;
};

/** The sync declaration a procedure may override in part (§F). */
export type SyncOverride = {
  readonly cadence?: 'CONTINUOUS' | 'AT_CLOSE';
  readonly deletePropagation?: boolean;
};

/**
 * The resolved shape. Every style must produce exactly this, and it must be
 * readable WITHOUT running the procedure — one of §N's three criteria.
 */
export type ResolvedProcedure<
  OuterInput extends z.ZodTypeAny,
  OuterOutput extends z.ZodTypeAny,
  AgentOutput extends z.ZodTypeAny,
> = {
  readonly contract: Contract<OuterInput, OuterOutput>;
  readonly agentOutput: AgentOutput;
  readonly prompt: (input: z.infer<OuterInput>) => string;
  readonly options: RunOptions;
  readonly guardrails: readonly Guardrail[];
  readonly sync?: SyncOverride;
  /** agent output -> outer output. Where computed fields are added (D2). */
  readonly marshal: (agentOutput: z.infer<AgentOutput>, input: z.infer<OuterInput>) => z.infer<OuterOutput>;
  readonly before?: (input: z.infer<OuterInput>, context: PhaseContext) => Promise<void>;
  readonly afterSuccess?: (output: z.infer<OuterOutput>, context: PhaseContext) => Promise<void>;
  readonly afterFailure?: (error: unknown, context: PhaseContext) => Promise<void>;
};

// ---------------------------------------------------------------------------
// The domain the baseline is written against. Neutral vocabulary throughout.
// ---------------------------------------------------------------------------

/** 1. minimal */
export const summariseInput = z.object({
  documentPath: z.string().describe('the file to summarise, relative to the working directory'),
});
export const summariseOutput = z.object({
  summary: z.string().describe('a summary of the document'),
  wordCount: z.number().int().describe('how many words the summary contains'),
});

/** 2. computed — `reviewedAt` and `sourceDigest` must never be asked of a model. */
export const reviewInput = z.object({
  documentPath: z.string().describe('the file to review'),
  sourceDigest: z.string().describe('the digest of the file as the caller saw it'),
});
export const reviewAgentOutput = z.object({
  findings: z
    .array(z.object({ line: z.number().int(), note: z.string() }))
    .describe('each problem found, with the line it is on'),
  verdict: z.enum(['ACCEPT', 'REVISE']).describe('whether the document is acceptable as it stands'),
});
export const reviewOuterOutput = z.object({
  findings: z.array(z.object({ line: z.number().int(), note: z.string() })),
  verdict: z.enum(['ACCEPT', 'REVISE']),
  // Computed in the marshal step. The model is never asked for either.
  reviewedAt: z.string().describe('when the review completed'),
  sourceDigest: z.string().describe('echoed from the input, so a caller can detect drift'),
});

/** 3. phased — a working copy prepared before, committed after. */
export const reviseInput = z.object({
  documentPath: z.string(),
  instruction: z.string().describe('what to change'),
});
export const reviseAgentOutput = z.object({
  changed: z.boolean().describe('whether the document was changed'),
  rationale: z.string().describe('why, in one sentence'),
});
export const reviseOuterOutput = z.object({
  changed: z.boolean(),
  rationale: z.string(),
  committed: z.boolean().describe('whether the change was committed; computed by the after phase'),
});

/** 4. guarded — writes confined, and the session cannot end without an artifact. */
export const draftInput = z.object({
  topic: z.string(),
  outputPath: z.string().describe('where the draft must be written'),
});
export const draftOutput = z.object({
  path: z.string().describe('where the draft was written'),
  sections: z.number().int().describe('how many sections it has'),
});

/** 5. discriminated — a halt is a SUCCESS under its own discriminator (T19). */
export const gateInput = z.object({ candidatePath: z.string() });
export const gateOutput = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('PROCEED'),
    confidence: z.number().describe('0 to 1'),
  }),
  z.object({
    decision: z.literal('HALT'),
    reason: z.string().describe('why this must not proceed'),
  }),
]);

// ---------------------------------------------------------------------------
// A house style, shared across procedures. Contributions are ADDITIVE (D8).
// ---------------------------------------------------------------------------

export const houseOptions: RunOptions = {
  model: 'claude-sonnet-5',
  maxTurns: 40,
  disallowedTools: ['WebFetch'],
};

export const houseGuardrails: readonly Guardrail[] = [
  { label: 'house/no-writes-outside-workspace', kind: 'writeScope', matcher: 'Write|Edit' },
  { label: 'house/disclose', kind: 'disclosure', matcher: '*' },
];
