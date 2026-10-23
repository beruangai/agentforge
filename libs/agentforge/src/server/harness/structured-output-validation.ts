import { z } from 'zod';
import type { StopGuard } from './stop-guard.ts';

/**
 * A structured output submission checked before it is accepted (§REQ208):
 * the agent contract's parse, which catches what the JSON Schema the agent
 * sees cannot state, and every stop guard, all run before it answers, so the
 * agent learns every failure in one refusal rather than spending an attempt
 * on each. Resolves to undefined when the submission is accepted, or to the
 * refusal to tell the agent. A guard or a parse that throws is a defect, not
 * something to tell the agent: the promise rejects with it.
 */
export async function validateStructuredOutput(
  options: {
    readonly output: z.ZodType;
    readonly guards: readonly StopGuard[];
  },
  submission: unknown,
): Promise<string | undefined> {
  const [parsed, ...guarded] = await Promise.allSettled([
    options.output.safeParseAsync(submission),
    ...options.guards.map((guard) => guard()),
  ]);
  const rejected = [parsed, ...guarded].find(
    (settled) => settled?.status === 'rejected',
  );
  if (rejected?.status === 'rejected') throw rejected.reason;
  const contractError =
    parsed?.status === 'fulfilled' && !parsed.value.success
      ? z.prettifyError(parsed.value.error)
      : undefined;
  const reasons = guarded.flatMap((settled) =>
    settled.status === 'fulfilled' && settled.value !== undefined
      ? [settled.value.reason]
      : [],
  );
  if (contractError === undefined && reasons.length === 0) return undefined;
  console.log(
    JSON.stringify({
      event: 'agentforge.structured_output.refused',
      contractError,
      reasons,
    }),
  );
  return refusal(contractError, reasons);
}

function refusal(
  contractError: string | undefined,
  reasons: readonly string[],
): string {
  const sections = [
    'Your structured output was not accepted. Fix every point below, then submit it again.',
  ];
  if (contractError !== undefined) {
    sections.push(
      `The structured output does not match its contract, which is stricter than the JSON Schema you were shown:\n${contractError}`,
    );
  }
  if (reasons.length > 0) {
    sections.push(
      `Before submitting:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}
