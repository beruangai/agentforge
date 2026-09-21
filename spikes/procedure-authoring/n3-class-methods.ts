/**
 * §N candidate 3 — a class whose methods are the steps.
 *
 * `class Review extends Procedure { prompt() {} marshal() {} afterSuccess() {} }`.
 * Familiar and discoverable; §N's stated risk is that overriding rather than
 * contributing becomes the habit. The baseline is written to make that risk
 * visible rather than to argue about it: `guardrails()` and `options()` are
 * places where a subclass can silently *replace* the house contribution.
 */
import { z } from 'zod';
import {
  contract,
  houseGuardrails,
  houseOptions,
  type Guardrail,
  type PhaseContext,
  type ResolvedProcedure,
  type RunOptions,
  type SyncOverride,
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

export abstract class Procedure<
  OuterInput extends z.ZodTypeAny,
  OuterOutput extends z.ZodTypeAny,
  AgentOutput extends z.ZodTypeAny,
> {
  abstract readonly name: string;
  abstract readonly input: OuterInput;
  abstract readonly output: OuterOutput;
  abstract readonly agentOutput: AgentOutput;

  abstract prompt(input: z.infer<OuterInput>): string;
  abstract marshal(agentOutput: z.infer<AgentOutput>, input: z.infer<OuterInput>): z.infer<OuterOutput>;

  /** A subclass overriding this REPLACES the house options rather than adding. */
  options(): RunOptions {
    return houseOptions;
  }

  /** Same hazard, and the one §N names. */
  guardrails(): readonly Guardrail[] {
    return houseGuardrails;
  }

  sync(): SyncOverride | undefined {
    return undefined;
  }

  before?(input: z.infer<OuterInput>, context: PhaseContext): Promise<void>;
  afterSuccess?(output: z.infer<OuterOutput>, context: PhaseContext): Promise<void>;
  afterFailure?(error: unknown, context: PhaseContext): Promise<void>;

  /** Resolving requires INSTANTIATING the class and calling its methods. */
  resolve(): ResolvedProcedure<OuterInput, OuterOutput, AgentOutput> {
    return {
      contract: contract(this.name, this.input, this.output),
      agentOutput: this.agentOutput,
      prompt: (input) => this.prompt(input),
      options: this.options(),
      guardrails: this.guardrails(),
      sync: this.sync(),
      marshal: (agentOutput, input) => this.marshal(agentOutput, input),
      before: this.before?.bind(this),
      afterSuccess: this.afterSuccess?.bind(this),
      afterFailure: this.afterFailure?.bind(this),
    };
  }
}

// --- 1. minimal ------------------------------------------------------------

export class Summarise extends Procedure<typeof summariseInput, typeof summariseOutput, typeof summariseOutput> {
  readonly name = 'document.summarise';
  readonly input = summariseInput;
  readonly output = summariseOutput;
  readonly agentOutput = summariseOutput;

  prompt(input: z.infer<typeof summariseInput>) {
    return `Read ${input.documentPath} and summarise it.`;
  }
  override options(): RunOptions {
    // The additive form has to be written out by hand, every time.
    return { ...super.options(), allowedTools: ['Read', 'Glob'] };
  }
  marshal(agentOutput: z.infer<typeof summariseOutput>) {
    return agentOutput;
  }
}

// --- 2. computed -----------------------------------------------------------

export class Review extends Procedure<typeof reviewInput, typeof reviewOuterOutput, typeof reviewAgentOutput> {
  readonly name = 'document.review';
  readonly input = reviewInput;
  readonly output = reviewOuterOutput;
  readonly agentOutput = reviewAgentOutput;

  prompt(input: z.infer<typeof reviewInput>) {
    return `Review ${input.documentPath} and report every problem with its line number.`;
  }
  override options(): RunOptions {
    return { ...super.options(), allowedTools: ['Read', 'Grep'] };
  }
  marshal(agentOutput: z.infer<typeof reviewAgentOutput>, input: z.infer<typeof reviewInput>) {
    return { ...agentOutput, reviewedAt: new Date().toISOString(), sourceDigest: input.sourceDigest };
  }
}

// --- 3. phased -------------------------------------------------------------

export class Revise extends Procedure<typeof reviseInput, typeof reviseOuterOutput, typeof reviseAgentOutput> {
  readonly name = 'document.revise';
  readonly input = reviseInput;
  readonly output = reviseOuterOutput;
  readonly agentOutput = reviseAgentOutput;

  prompt(input: z.infer<typeof reviseInput>) {
    return `Apply this instruction to ${input.documentPath}: ${input.instruction}`;
  }
  override options(): RunOptions {
    return { ...super.options(), allowedTools: ['Read', 'Edit', 'Write'] };
  }
  override sync(): SyncOverride {
    return { cadence: 'AT_CLOSE' };
  }
  marshal(agentOutput: z.infer<typeof reviseAgentOutput>) {
    return { ...agentOutput, committed: false };
  }
  override async before(_input: z.infer<typeof reviseInput>, context: PhaseContext) {
    if (context.priorAttempt === 'LOST') await reconcileWorkingCopy(context.idempotencyKey);
    await prepareWorkingCopy();
  }
  override async afterSuccess(output: z.infer<typeof reviseOuterOutput>) {
    if (output.changed) await commitAndPush();
  }
  override async afterFailure() {
    await discardWorkingCopy();
  }
}

// --- 4. guarded ------------------------------------------------------------

export class Draft extends Procedure<typeof draftInput, typeof draftOutput, typeof draftOutput> {
  readonly name = 'document.draft';
  readonly input = draftInput;
  readonly output = draftOutput;
  readonly agentOutput = draftOutput;

  prompt(input: z.infer<typeof draftInput>) {
    return `Write a draft about ${input.topic} to ${input.outputPath}.`;
  }
  override options(): RunOptions {
    return { ...super.options(), allowedTools: ['Read', 'Write', 'Edit'] };
  }
  override guardrails(): readonly Guardrail[] {
    // The hazard, in one line: drop `...super.guardrails()` and the house
    // guardrails silently disappear. Nothing in the type system objects.
    return [
      ...super.guardrails(),
      { label: 'draft/writes-under-drafts', kind: 'writeScope', matcher: 'Write|Edit' },
      { label: 'draft/must-produce-the-file', kind: 'stopGuard', matcher: 'Stop' },
    ];
  }
  marshal(agentOutput: z.infer<typeof draftOutput>) {
    return agentOutput;
  }
}

// --- 5. discriminated ------------------------------------------------------

export class Gate extends Procedure<typeof gateInput, typeof gateOutput, typeof gateOutput> {
  readonly name = 'document.gate';
  readonly input = gateInput;
  readonly output = gateOutput;
  readonly agentOutput = gateOutput;

  prompt(input: z.infer<typeof gateInput>) {
    return `Decide whether ${input.candidatePath} may proceed. A halt is a valid answer.`;
  }
  override options(): RunOptions {
    return { ...super.options(), allowedTools: ['Read'], maxTurns: 12 };
  }
  marshal(agentOutput: z.infer<typeof gateOutput>) {
    return agentOutput;
  }
}

export const all = [new Summarise(), new Review(), new Revise(), new Draft(), new Gate()];

async function prepareWorkingCopy(): Promise<void> {}
async function reconcileWorkingCopy(_key: string): Promise<void> {}
async function commitAndPush(): Promise<void> {}
async function discardWorkingCopy(): Promise<void> {}
