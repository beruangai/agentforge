/**
 * Does an in-turn PreToolUse rejection still add anything over native
 * re-prompting, and does its matcher name a tool that actually exists?
 *
 * The structured-output submission is carried by a real tool named
 * `StructuredOutput` (foreground-settlement.test.ts), so a PreToolUse matcher
 * can name it. What is asserted here is what a hook over it does that the
 * SDK's own validation and re-prompting cannot. Every run uses the kernel's
 * configuration: streaming input, background work off, the input ended on the
 * first result (docs/ARCHITECTURE.md §6).
 *
 * Two SCENARIOS, the two things AgentForge relies on a hook for:
 *
 *   hook-only-rule       a cross-field rule JSON Schema cannot express, enforced
 *                        by a PreToolUse denial. Whether the model then complies
 *                        or argues is its choice and varies run to run; what is
 *                        asserted is what holds either way — the denial reaches
 *                        the model verbatim, a denied submission never becomes
 *                        the result, and a run that ends with no allowed one
 *                        ends `success` with no `structured_output`, the shape
 *                        the kernel maps to OUTPUT_INVALID.
 *   hook-updated-input   the hook repairs the submission via `updatedInput`
 *                        instead of rejecting it — no extra model turn.
 *
 * Not re-tested, and recorded in the findings: native schema re-prompting (the
 * SDK's documented structured-output behaviour, and AgentForge validates the
 * settled output itself), a schema-expressible rule enforced by a hook (settled
 * once: it belongs in the schema), and a matcher naming no tool (it fires zero
 * times; AgentForge asserts its matchers against `init.tools` at startup).
 *
 * Findings: docs/research/kernel-settlement.md, "E3".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HookCallback,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { BACKGROUND_WORK_DISABLED } from '../../../src/server/harness/kernel.ts';
import { structuredOutputJsonSchema } from '../../../src/server/harness/structured-output.ts';
import {
  CARRIER_TOOL_NAME,
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
  runWithStreamingInput,
} from '../../__fixtures__/claude-agent-sdk.ts';

/** Fixture sizes chosen so the sum is not a round number the model can guess. */
const FIXTURE_FILE_SIZES: Record<string, number> = {
  'alpha.txt': 137,
  'beta.txt': 2891,
  'gamma.txt': 15043,
};

const BaseOutputShape = {
  files: z
    .array(z.object({ name: z.string(), bytes: z.number().int() }))
    .describe(
      'every .txt file in the working directory, with its exact byte size',
    ),
  totalBytes: z.number().int().describe('the total size'),
  summary: z.string().describe('a short summary'),
};

const PROMPT =
  "Use Bash to list every .txt file in the current directory and get each one's exact byte size. " +
  'Then give your final structured output: every file with its size, the total, and a summary. ' +
  'Write the summary as a normal descriptive sentence.';

/** Cap the correction loop: a rule the model cannot satisfy must not spin forever at the operator's expense. */
const MAXIMUM_DENIALS = 3;

type CarrierInput = {
  files?: { name?: string; bytes?: number }[];
  totalBytes?: number;
  summary?: string;
};

type HookCall = {
  toolName: string;
  decision: 'allow' | 'deny' | 'updatedInput';
  /** What the model submitted, as the hook saw it. */
  input: CarrierInput;
  reason?: string;
  repairedSummary?: string;
};

type Scenario = {
  name: string;
  /** Returns a denial reason, or undefined to allow. */
  check?: (input: CarrierInput) => string | undefined;
  /** Returns a repaired input, or undefined to leave it alone. */
  repair?: (input: CarrierInput) => CarrierInput | undefined;
};

// Cross-field AND unstated in the PROMPT or the schema: JSON Schema cannot
// express it, and the model cannot guess it, so the denial path is guaranteed
// to be exercised rather than merely available.
const checkTotalInWholeKilobytes = (
  input: CarrierInput,
): string | undefined => {
  const sum = (input.files ?? []).reduce(
    (total, file) => total + (file.bytes ?? 0),
    0,
  );
  const required = Math.ceil(sum / 1024);
  if (input.totalBytes === required) return undefined;
  return (
    `"totalBytes" must be the total expressed in WHOLE KILOBYTES, rounded up — not bytes. ` +
    `The files sum to ${sum} bytes, so totalBytes must be ${required}. You submitted ${input.totalBytes}. Resubmit.`
  );
};

const repairToFiveWords = (input: CarrierInput): CarrierInput | undefined => {
  const words = String(input.summary ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 5) return undefined;
  return {
    ...input,
    summary: words.slice(0, 5).join(' ') || 'repaired by the harness hook',
  };
};

const SCENARIOS = {
  hookOnlyRule: {
    name: 'hook-only-rule',
    check: checkTotalInWholeKilobytes,
  },
  hookUpdatedInput: {
    name: 'hook-updated-input',
    repair: repairToFiveWords,
  },
} satisfies Record<string, Scenario>;

async function runScenario(scenario: Scenario) {
  const sandbox = createSandbox(`in-turn-correction-${scenario.name}`);
  onTestFinished(() => sandbox.dispose());
  for (const [name, size] of Object.entries(FIXTURE_FILE_SIZES)) {
    writeFileSync(join(sandbox.workingDirectory, name), 'x'.repeat(size));
  }

  const OUTPUT_JSON_SCHEMA = structuredOutputJsonSchema(
    z.object(BaseOutputShape),
  );

  const hookCalls: HookCall[] = [];
  let denials = 0;

  const preToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      throw new Error(`PreToolUse hook received ${input.hook_event_name}`);
    }
    const toolName = input.tool_name;
    const toolInput = input.tool_input as CarrierInput;
    if (scenario.repair) {
      const updated = scenario.repair(toolInput);
      hookCalls.push({
        toolName,
        decision: updated ? 'updatedInput' : 'allow',
        input: toolInput,
        ...(updated ? { repairedSummary: updated.summary } : {}),
      });
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          ...(updated ? { updatedInput: updated } : {}),
        },
      } satisfies HookJSONOutput;
    }
    const reason =
      denials >= MAXIMUM_DENIALS ? undefined : scenario.check?.(toolInput);
    hookCalls.push({
      toolName,
      decision: reason ? 'deny' : 'allow',
      input: toolInput,
      ...(reason ? { reason } : {}),
    });
    if (reason) denials += 1;
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: reason ? 'deny' : 'allow',
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    } satisfies HookJSONOutput;
  };

  const recording = new QueryRecording(
    'kernel-settlement',
    `in-turn-correction-${scenario.name}`,
  );
  await runWithStreamingInput(recording, PROMPT, {
    cwd: sandbox.workingDirectory,
    env: createSubscriptionEnvironment(
      sandbox.configDirectory,
      BACKGROUND_WORK_DISABLED,
    ),
    model: 'claude-sonnet-5',
    allowedTools: ['Bash'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    outputFormat: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
    maxTurns: 25,
    settingSources: [],
    hooks: {
      PreToolUse: [{ matcher: CARRIER_TOOL_NAME, hooks: [preToolUseHook] }],
    },
  });

  const result = recording.onlyResultMessage();
  const structuredOutput = (
    result.subtype === 'success' ? result.structured_output : undefined
  ) as CarrierInput | null | undefined;
  const carrierToolUses = recording
    .toolUses()
    .filter((toolUse) => toolUse.name === CARRIER_TOOL_NAME);
  const evidence = [
    `subtype=${result.subtype} is_error=${result.is_error} num_turns=${result.num_turns}`,
    `carrierSubmissions=${carrierToolUses.length} hookCalls=${JSON.stringify(hookCalls.map((call) => call.decision))}`,
    `structured_output=${JSON.stringify(structuredOutput)}`,
    `cost=$${result.total_cost_usd.toFixed(4)}`,
    `see ${recording.logPath}`,
  ].join('; ');

  expect(
    recording.firstSystemInitMessage().tools,
    `'${CARRIER_TOOL_NAME}' is advertised in system/init.tools; ${evidence}`,
  ).toContain(CARRIER_TOOL_NAME);

  return {
    recording,
    result,
    structuredOutput,
    carrierToolUses,
    hookCalls,
    denials,
    evidence,
  };
}

/** The carrier's is_error tool_results, in order. */
function carrierErrorTexts(
  recording: QueryRecording,
  carrierToolUseIds: string[],
): string[] {
  return recording
    .toolResults()
    .filter(
      (toolResult) =>
        toolResult.isError && carrierToolUseIds.includes(toolResult.toolUseId),
    )
    .map((toolResult) => toolResult.text);
}

describe('in-turn PreToolUse rejection over StructuredOutput', () => {
  it(SCENARIOS.hookOnlyRule.name, async () => {
    const run = await runScenario(SCENARIOS.hookOnlyRule);
    expect(
      new Set(run.hookCalls.map((call) => call.toolName)),
      `the hook sees the carrier under its emitted name; ${run.evidence}`,
    ).toEqual(new Set([CARRIER_TOOL_NAME]));
    expect(
      run.denials,
      `the cross-field rule was denied in-turn; ${run.evidence}`,
    ).toBeGreaterThanOrEqual(1);
    // The denial reason reaches the model verbatim, as an is_error tool_result
    // on the carrier.
    const deniedReasons = run.hookCalls
      .filter((call) => call.decision === 'deny')
      .map((call) => call.reason);
    expect(
      carrierErrorTexts(
        run.recording,
        run.carrierToolUses.map((toolUse) => toolUse.id),
      ).filter((text) =>
        deniedReasons.some(
          (reason) => reason !== undefined && text.includes(reason),
        ),
      ),
      `every denial reason reaches the model verbatim; ${run.evidence}`,
    ).toHaveLength(run.denials);
    // The model may comply or argue until it gives up. Both outcomes are
    // asserted: what is delivered is a submission the hook allowed, or the run
    // ends a success with no output, which the kernel maps to OUTPUT_INVALID.
    const deniedInputs = run.hookCalls
      .filter((call) => call.decision === 'deny')
      .map((call) => call.input);
    const allowedInputs = run.hookCalls
      .filter((call) => call.decision === 'allow')
      .map((call) => call.input);
    if (run.structuredOutput != null) {
      expect(
        allowedInputs,
        `the delivered output is a submission the hook allowed; ${run.evidence}`,
      ).toContainEqual(run.structuredOutput);
      expect(
        deniedInputs,
        `the delivered output is not a submission the hook denied; ${run.evidence}`,
      ).not.toContainEqual(run.structuredOutput);
    } else {
      expect(
        { subtype: run.result.subtype, isError: run.result.is_error },
        `a run that ends with no structured_output ends an ordinary success — OUTPUT_INVALID to the kernel; ${run.evidence}`,
      ).toEqual({ subtype: 'success', isError: false });
    }
  });

  it(SCENARIOS.hookUpdatedInput.name, async () => {
    const run = await runScenario(SCENARIOS.hookUpdatedInput);
    const repairs = run.hookCalls.filter(
      (call) => call.decision === 'updatedInput',
    );
    expect(
      repairs,
      `the model's summary was not five words, so the hook repaired it once; ${run.evidence}`,
    ).toHaveLength(1);
    expect(
      run.carrierToolUses,
      `a repair costs no additional submission; ${run.evidence}`,
    ).toHaveLength(1);
    expect(
      run.structuredOutput?.summary,
      `the DELIVERED structured_output carries the repaired value; ${run.evidence}`,
    ).toBe(repairs[0]?.repairedSummary);
  });
});
