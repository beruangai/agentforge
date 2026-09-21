/**
 * §N candidate 1 — the object literal.
 *
 * `procedure({ ... })`: one call, one object, every part named. The resolved
 * configuration IS the declaration.
 */
import { z } from 'zod';
import {
  contract,
  houseGuardrails,
  houseOptions,
  type Guardrail,
  type ResolvedProcedure,
  type RunOptions,
  type SyncOverride,
  type PhaseContext,
  type Contract,
  draftInput,
  draftOutput,
  gateInput,
  gateOutput,
  reviewAgentOutput,
  reviewInput,
  reviewOuterOutput,
  reviseAgentOutput,
  reviseInput,
  reviseOuterOutput,
  summariseInput,
  summariseOutput,
} from './baseline.ts';

type Declaration<
  OuterInput extends z.ZodTypeAny,
  OuterOutput extends z.ZodTypeAny,
  AgentOutput extends z.ZodTypeAny,
> = {
  contract: Contract<OuterInput, OuterOutput>;
  agentOutput: AgentOutput;
  prompt: (input: z.infer<OuterInput>) => string;
  options?: RunOptions;
  guardrails?: readonly Guardrail[];
  sync?: SyncOverride;
  marshal: (agentOutput: z.infer<AgentOutput>, input: z.infer<OuterInput>) => z.infer<OuterOutput>;
  before?: (input: z.infer<OuterInput>, context: PhaseContext) => Promise<void>;
  afterSuccess?: (output: z.infer<OuterOutput>, context: PhaseContext) => Promise<void>;
  afterFailure?: (error: unknown, context: PhaseContext) => Promise<void>;
};

export function procedure<
  OuterInput extends z.ZodTypeAny,
  OuterOutput extends z.ZodTypeAny,
  AgentOutput extends z.ZodTypeAny,
>(
  declaration: Declaration<OuterInput, OuterOutput, AgentOutput>,
): ResolvedProcedure<OuterInput, OuterOutput, AgentOutput> {
  return {
    ...declaration,
    // Additive by construction: the house contributions come first and a
    // procedure's own are concatenated, never substituted (D8).
    options: { ...houseOptions, ...declaration.options },
    guardrails: [...houseGuardrails, ...(declaration.guardrails ?? [])],
  };
}

// --- 1. minimal ------------------------------------------------------------

export const summarise = procedure({
  contract: contract('document.summarise', summariseInput, summariseOutput),
  agentOutput: summariseOutput,
  prompt: (input) => `Read ${input.documentPath} and summarise it.`,
  options: { allowedTools: ['Read', 'Glob'] },
  marshal: (agentOutput) => agentOutput,
});

// --- 2. computed -----------------------------------------------------------

export const review = procedure({
  contract: contract('document.review', reviewInput, reviewOuterOutput),
  agentOutput: reviewAgentOutput,
  prompt: (input) => `Review ${input.documentPath} and report every problem with its line number.`,
  options: { allowedTools: ['Read', 'Grep'] },
  // The two computed fields are added HERE, never asked of the model.
  marshal: (agentOutput, input) => ({
    ...agentOutput,
    reviewedAt: new Date().toISOString(),
    sourceDigest: input.sourceDigest,
  }),
});

// --- 3. phased -------------------------------------------------------------

export const revise = procedure({
  contract: contract('document.revise', reviseInput, reviseOuterOutput),
  agentOutput: reviseAgentOutput,
  prompt: (input) => `Apply this instruction to ${input.documentPath}: ${input.instruction}`,
  options: { allowedTools: ['Read', 'Edit', 'Write'] },
  sync: { cadence: 'AT_CLOSE' },
  marshal: (agentOutput) => ({ ...agentOutput, committed: false }),
  before: async (_input, context) => {
    if (context.priorAttempt === 'LOST') {
      // Side effects may have happened; the consumer reconciles (ARCHITECTURE §3).
      await reconcileWorkingCopy(context.idempotencyKey);
    }
    await prepareWorkingCopy();
  },
  afterSuccess: async (output) => {
    if (output.changed) await commitAndPush();
  },
  afterFailure: async () => {
    await discardWorkingCopy();
  },
});

// --- 4. guarded ------------------------------------------------------------

export const draft = procedure({
  contract: contract('document.draft', draftInput, draftOutput),
  agentOutput: draftOutput,
  prompt: (input) => `Write a draft about ${input.topic} to ${input.outputPath}.`,
  options: { allowedTools: ['Read', 'Write', 'Edit'] },
  guardrails: [
    { label: 'draft/writes-under-drafts', kind: 'writeScope', matcher: 'Write|Edit' },
    { label: 'draft/must-produce-the-file', kind: 'stopGuard', matcher: 'Stop' },
  ],
  marshal: (agentOutput) => agentOutput,
});

// --- 5. discriminated ------------------------------------------------------

export const gate = procedure({
  contract: contract('document.gate', gateInput, gateOutput),
  agentOutput: gateOutput,
  prompt: (input) => `Decide whether ${input.candidatePath} may proceed. A halt is a valid answer.`,
  options: { allowedTools: ['Read'], maxTurns: 12 },
  marshal: (agentOutput) => agentOutput,
});

// --- side effects, stubbed -------------------------------------------------
async function prepareWorkingCopy(): Promise<void> {}
async function reconcileWorkingCopy(_key: string): Promise<void> {}
async function commitAndPush(): Promise<void> {}
async function discardWorkingCopy(): Promise<void> {}
