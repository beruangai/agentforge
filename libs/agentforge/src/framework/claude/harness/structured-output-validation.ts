import type {
  HookCallback,
  HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { StopGuard } from '../../../server/harness/stop-guard.ts';
import { validateStructuredOutput } from '../../../server/harness/structured-output-validation.ts';
import { unwrapStructuredOutput } from './structured-output.ts';

/** The tool the agent submits its structured output through, advertised in `init.tools`. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * The kernel's own `PreToolUse` entry on the structured output submission
 * (§REQ208): the submission, unwrapped, is validated before the hook returns,
 * and a refusal is the hook's denial. A guard that throws is handed to
 * `onGuardError`, which ends the run. Each refusal is handed to `onRefused`,
 * so a run whose agent gives up after one can say why.
 */
export function structuredOutputValidation(options: {
  readonly output: z.ZodType;
  readonly wrapped: boolean;
  readonly guards: readonly StopGuard[];
  readonly onRefused: (reason: string) => void;
  readonly onGuardError: (error: unknown) => void;
}): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    if (
      input.hook_event_name !== 'PreToolUse' ||
      input.tool_name !== STRUCTURED_OUTPUT_TOOL
    ) {
      return {};
    }
    const submission = unwrapStructuredOutput(
      input.tool_input,
      options.wrapped,
    );
    let reason: string | undefined;
    try {
      reason = await validateStructuredOutput(options, submission);
    } catch (error) {
      options.onGuardError(error);
      return refuse(
        'Your structured output could not be validated. Stop: this run is ending.',
      );
    }
    if (reason === undefined) return {};
    options.onRefused(reason);
    return refuse(reason);
  };
  return { matcher: STRUCTURED_OUTPUT_TOOL, hooks: [hook] };
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
