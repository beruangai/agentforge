import type {
  HookCallback,
  HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { unwrapStructuredOutput } from './structured-output.ts';

/** A check that must pass before the agent's answer is accepted; the agent contract is always checked beside it. */
export type StopGuard = () => Promise<StopGuardDenial | undefined>;

export interface StopGuardDenial {
  /** Told to the agent, in its turn: what is wrong and what to do. */
  readonly reason: string;
}

/** The tool the agent submits its answer through, advertised in `init.tools`. */
export const ANSWER_TOOL = 'StructuredOutput';

/**
 * The kernel's own `PreToolUse` entry on the answer submission (§REQ208).
 * Every failure — the agent contract's parse, which catches what the JSON
 * Schema the agent sees cannot state, and every stop guard's denial — is
 * collected before the hook answers, so the agent learns all of them in one
 * denial rather than spending an attempt on each. A guard that throws is a
 * defect, not something to tell the agent: it is handed to `onGuardError`,
 * which ends the run. Each refusal is handed to `onRefused`, so a run whose
 * agent gives up after one can say why.
 */
export function answerCheck(options: {
  readonly output: z.ZodType;
  readonly wrapped: boolean;
  readonly guards: readonly StopGuard[];
  readonly onRefused: (reason: string) => void;
  readonly onGuardError: (error: unknown) => void;
}): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    if (
      input.hook_event_name !== 'PreToolUse' ||
      input.tool_name !== ANSWER_TOOL
    ) {
      return {};
    }
    const [parsed, ...guarded] = await Promise.allSettled([
      options.output.safeParseAsync(
        unwrapStructuredOutput(input.tool_input, options.wrapped),
      ),
      ...options.guards.map((guard) => guard()),
    ]);
    const rejected = [parsed, ...guarded].find(
      (settled) => settled?.status === 'rejected',
    );
    if (rejected?.status === 'rejected') {
      options.onGuardError(rejected.reason);
      return refuse(
        'Your answer could not be checked. Stop: this run is ending.',
      );
    }
    const contractError =
      parsed?.status === 'fulfilled' && !parsed.value.success
        ? z.prettifyError(parsed.value.error)
        : undefined;
    const reasons = guarded.flatMap((settled) =>
      settled.status === 'fulfilled' && settled.value !== undefined
        ? [settled.value.reason]
        : [],
    );
    if (contractError === undefined && reasons.length === 0) return {};
    console.log(
      JSON.stringify({
        event: 'agentforge.answer.refused',
        contractError,
        reasons,
      }),
    );
    const reason = refusal(contractError, reasons);
    options.onRefused(reason);
    return refuse(reason);
  };
  return { matcher: ANSWER_TOOL, hooks: [hook] };
}

function refusal(
  contractError: string | undefined,
  reasons: readonly string[],
): string {
  const sections = [
    'Your answer was not accepted. Fix every point below, then submit your answer again.',
  ];
  if (contractError !== undefined) {
    sections.push(
      `The answer does not match its contract, which is stricter than the JSON Schema you were shown:\n${contractError}`,
    );
  }
  if (reasons.length > 0) {
    sections.push(
      `Before answering:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

function refuse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}
