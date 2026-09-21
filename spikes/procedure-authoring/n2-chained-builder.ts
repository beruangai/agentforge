/**
 * §N candidate 2 — the chained builder.
 *
 * `define(name).input(…).output(…).agentOutput(…).prompt(…).marshal(…).build()`.
 * The chain carries types forward, and the builder's own types can make an
 * invalid composition a compile error — `.build()` is only reachable once the
 * required parts are present.
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

/**
 * The builder's state is in its type parameters, so the compiler knows which
 * parts are still missing. `build()` exists only on a fully specified builder.
 */
class Builder<
  OuterInput extends z.ZodTypeAny | undefined = undefined,
  OuterOutput extends z.ZodTypeAny | undefined = undefined,
  AgentOutput extends z.ZodTypeAny | undefined = undefined,
  HasPrompt extends boolean = false,
  HasMarshal extends boolean = false,
> {
  private constructor(
    private readonly name: string,
    private readonly parts: Record<string, unknown>,
  ) {}

  static define(name: string): Builder {
    return new Builder(name, { guardrails: [], options: {} });
  }

  input<T extends z.ZodTypeAny>(schema: T): Builder<T, OuterOutput, AgentOutput, HasPrompt, HasMarshal> {
    return new (Builder as any)(this.name, { ...this.parts, input: schema });
  }

  output<T extends z.ZodTypeAny>(schema: T): Builder<OuterInput, T, AgentOutput, HasPrompt, HasMarshal> {
    return new (Builder as any)(this.name, { ...this.parts, output: schema });
  }

  agentOutput<T extends z.ZodTypeAny>(schema: T): Builder<OuterInput, OuterOutput, T, HasPrompt, HasMarshal> {
    return new (Builder as any)(this.name, { ...this.parts, agentOutput: schema });
  }

  /** Only callable once `input` is set, and it infers the input's type. */
  prompt(
    this: OuterInput extends z.ZodTypeAny ? Builder<OuterInput, OuterOutput, AgentOutput, HasPrompt, HasMarshal> : never,
    build: (input: z.infer<NonNullable<OuterInput>>) => string,
  ): Builder<OuterInput, OuterOutput, AgentOutput, true, HasMarshal> {
    return new (Builder as any)((this as any).name, { ...(this as any).parts, prompt: build });
  }

  /** Only callable once all three schemas are set; infers both sides. */
  marshal(
    this: OuterInput extends z.ZodTypeAny
      ? OuterOutput extends z.ZodTypeAny
        ? AgentOutput extends z.ZodTypeAny
          ? Builder<OuterInput, OuterOutput, AgentOutput, HasPrompt, HasMarshal>
          : never
        : never
      : never,
    step: (
      agentOutput: z.infer<NonNullable<AgentOutput>>,
      input: z.infer<NonNullable<OuterInput>>,
    ) => z.infer<NonNullable<OuterOutput>>,
  ): Builder<OuterInput, OuterOutput, AgentOutput, HasPrompt, true> {
    return new (Builder as any)((this as any).name, { ...(this as any).parts, marshal: step });
  }

  /** Additive: every call concatenates (D8). */
  options(options: RunOptions): this {
    return new (Builder as any)(this.name, {
      ...this.parts,
      options: { ...(this.parts.options as RunOptions), ...options },
    });
  }

  guardrail(...guardrails: Guardrail[]): this {
    return new (Builder as any)(this.name, {
      ...this.parts,
      guardrails: [...(this.parts.guardrails as Guardrail[]), ...guardrails],
    });
  }

  sync(sync: SyncOverride): this {
    return new (Builder as any)(this.name, { ...this.parts, sync });
  }

  before(
    this: OuterInput extends z.ZodTypeAny ? this : never,
    step: (input: z.infer<NonNullable<OuterInput>>, context: PhaseContext) => Promise<void>,
  ): this {
    return new (Builder as any)((this as any).name, { ...(this as any).parts, before: step });
  }

  afterSuccess(
    this: OuterOutput extends z.ZodTypeAny ? this : never,
    step: (output: z.infer<NonNullable<OuterOutput>>, context: PhaseContext) => Promise<void>,
  ): this {
    return new (Builder as any)((this as any).name, { ...(this as any).parts, afterSuccess: step });
  }

  afterFailure(step: (error: unknown, context: PhaseContext) => Promise<void>): this {
    return new (Builder as any)(this.name, { ...this.parts, afterFailure: step });
  }

  /** Reachable only when every required part is present. */
  build(
    this: OuterInput extends z.ZodTypeAny
      ? OuterOutput extends z.ZodTypeAny
        ? AgentOutput extends z.ZodTypeAny
          ? HasPrompt extends true
            ? HasMarshal extends true
              ? Builder<OuterInput, OuterOutput, AgentOutput, true, true>
              : never
            : never
          : never
        : never
      : never,
  ): ResolvedProcedure<NonNullable<OuterInput>, NonNullable<OuterOutput>, NonNullable<AgentOutput>> {
    const parts = (this as any).parts;
    return {
      contract: contract((this as any).name, parts.input, parts.output),
      agentOutput: parts.agentOutput,
      prompt: parts.prompt,
      options: { ...houseOptions, ...parts.options },
      guardrails: [...houseGuardrails, ...parts.guardrails],
      sync: parts.sync,
      marshal: parts.marshal,
      before: parts.before,
      afterSuccess: parts.afterSuccess,
      afterFailure: parts.afterFailure,
    };
  }
}

export const define = Builder.define;

// --- 1. minimal ------------------------------------------------------------

export const summarise = define('document.summarise')
  .input(summariseInput)
  .output(summariseOutput)
  .agentOutput(summariseOutput)
  .prompt((input) => `Read ${input.documentPath} and summarise it.`)
  .options({ allowedTools: ['Read', 'Glob'] })
  .marshal((agentOutput) => agentOutput)
  .build();

// --- 2. computed -----------------------------------------------------------

export const review = define('document.review')
  .input(reviewInput)
  .output(reviewOuterOutput)
  .agentOutput(reviewAgentOutput)
  .prompt((input) => `Review ${input.documentPath} and report every problem with its line number.`)
  .options({ allowedTools: ['Read', 'Grep'] })
  .marshal((agentOutput, input) => ({
    ...agentOutput,
    reviewedAt: new Date().toISOString(),
    sourceDigest: input.sourceDigest,
  }))
  .build();

// --- 3. phased -------------------------------------------------------------

export const revise = define('document.revise')
  .input(reviseInput)
  .output(reviseOuterOutput)
  .agentOutput(reviseAgentOutput)
  .prompt((input) => `Apply this instruction to ${input.documentPath}: ${input.instruction}`)
  .options({ allowedTools: ['Read', 'Edit', 'Write'] })
  .sync({ cadence: 'AT_CLOSE' })
  .marshal((agentOutput) => ({ ...agentOutput, committed: false }))
  .before(async (_input, context) => {
    if (context.priorAttempt === 'LOST') await reconcileWorkingCopy(context.idempotencyKey);
    await prepareWorkingCopy();
  })
  .afterSuccess(async (output) => {
    if (output.changed) await commitAndPush();
  })
  .afterFailure(async () => {
    await discardWorkingCopy();
  })
  .build();

// --- 4. guarded ------------------------------------------------------------

export const draft = define('document.draft')
  .input(draftInput)
  .output(draftOutput)
  .agentOutput(draftOutput)
  .prompt((input) => `Write a draft about ${input.topic} to ${input.outputPath}.`)
  .options({ allowedTools: ['Read', 'Write', 'Edit'] })
  .guardrail(
    { label: 'draft/writes-under-drafts', kind: 'writeScope', matcher: 'Write|Edit' },
    { label: 'draft/must-produce-the-file', kind: 'stopGuard', matcher: 'Stop' },
  )
  .marshal((agentOutput) => agentOutput)
  .build();

// --- 5. discriminated ------------------------------------------------------

export const gate = define('document.gate')
  .input(gateInput)
  .output(gateOutput)
  .agentOutput(gateOutput)
  .prompt((input) => `Decide whether ${input.candidatePath} may proceed. A halt is a valid answer.`)
  .options({ allowedTools: ['Read'], maxTurns: 12 })
  .marshal((agentOutput) => agentOutput)
  .build();

async function prepareWorkingCopy(): Promise<void> {}
async function reconcileWorkingCopy(_key: string): Promise<void> {}
async function commitAndPush(): Promise<void> {}
async function discardWorkingCopy(): Promise<void> {}
