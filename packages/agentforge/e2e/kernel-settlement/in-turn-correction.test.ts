/**
 * DESIGN_OPTIONS §E, question 3:
 *   "Does an in-turn PreToolUse rejection still add anything over native
 *    re-prompting, and does its matcher name a tool that actually exists?"
 *
 * The structured-output submission is carried by a real tool named
 * `StructuredOutput` (established by e1). So a PreToolUse matcher can name it.
 * What is not known is whether intercepting it buys anything now that the SDK
 * validates and re-prompts on its own.
 *
 * Five scenarios over the SAME underlying rule wherever a head-to-head is
 * possible, so the comparison is like-for-like:
 *
 *   native-schema-rule   the rule IS expressible in draft-07 (`pattern`), and
 *                        only the SDK's own validate-and-re-prompt enforces it.
 *   hook-schema-rule     the same rule, absent from the schema, enforced by a
 *                        PreToolUse denial instead.
 *   hook-only-rule       a cross-field rule draft-07 cannot express at all.
 *                        Native has no way to catch this; the hook does or does not.
 *   hook-updated-input   the hook repairs the submission via `updatedInput`
 *                        instead of rejecting it — no extra model turn.
 *   wrong-matcher        a matcher naming a tool that does not exist. The
 *                        failure mode to guard against: it must fire zero times.
 *
 * Findings: docs/research/kernel-settlement.md, "E3".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HookCallback,
  type HookJSONOutput,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
} from '../../integ/__fixtures__/claude-agent-sdk.ts';

const CARRIER_TOOL = 'StructuredOutput';

/** Fixture sizes chosen so the sum is not a round number the model can guess. */
const fixtureFileSizes: Record<string, number> = {
  'alpha.txt': 137,
  'beta.txt': 2891,
  'gamma.txt': 15043,
};
const EXPECTED_TOTAL_BYTES = 18071;

const baseShape = {
  files: z
    .array(z.object({ name: z.string(), bytes: z.number().int() }))
    .describe(
      'every .txt file in the working directory, with its exact byte size',
    ),
  totalBytes: z.number().int().describe('the total size'),
  summary: z.string().describe('a short summary'),
};

/** Exactly five words. Expressible in draft-07, so native re-prompting can enforce it. */
const FIVE_WORDS = '^\\S+(?: \\S+){4}$';

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

function wordCount(text: unknown): number {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

type HookCall = {
  toolName: string;
  decision: 'allow' | 'deny' | 'updatedInput';
  reason?: string;
  repairedSummary?: string;
};

type Scenario = {
  name: string;
  /** Adds the five-word rule to the schema, so the SDK enforces it natively. */
  ruleInSchema: boolean;
  matcher?: string;
  /** Returns a denial reason, or undefined to allow. */
  check?: (input: CarrierInput) => string | undefined;
  /** Returns a repaired input, or undefined to leave it alone. */
  repair?: (input: CarrierInput) => CarrierInput | undefined;
};

const checkFiveWordSummary = (input: CarrierInput): string | undefined =>
  wordCount(input.summary) === 5
    ? undefined
    : `The "summary" field must be EXACTLY five words. You wrote ${wordCount(input.summary)}. Resubmit with a five-word summary.`;

// Cross-field AND unstated in the prompt or the schema: draft-07 cannot
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

const scenarios: Record<string, Scenario> = {
  nativeSchemaRule: { name: 'native-schema-rule', ruleInSchema: true },
  hookSchemaRule: {
    name: 'hook-schema-rule',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    check: checkFiveWordSummary,
  },
  hookOnlyRule: {
    name: 'hook-only-rule',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    check: checkTotalInWholeKilobytes,
  },
  hookUpdatedInput: {
    name: 'hook-updated-input',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    repair: repairToFiveWords,
  },
  // Plural. Names no tool that exists. Must fire zero times.
  wrongMatcher: {
    name: 'wrong-matcher',
    ruleInSchema: false,
    matcher: 'StructuredOutputs',
    check: () => 'this hook should never have fired',
  },
};

async function runScenario(scenario: Scenario) {
  const sandbox = createSandbox(`e3-${scenario.name}`);
  onTestFinished(() => sandbox.dispose());
  for (const [name, size] of Object.entries(fixtureFileSizes)) {
    writeFileSync(join(sandbox.workingDirectory, name), 'x'.repeat(size));
  }

  const OutputSchema = z.object({
    ...baseShape,
    summary: scenario.ruleInSchema
      ? z
          .string()
          .regex(new RegExp(FIVE_WORDS))
          .describe('a summary of exactly five words')
      : baseShape.summary,
  });
  const outputJsonSchema = z.toJSONSchema(OutputSchema, {
    target: 'draft-7',
    io: 'input',
  });

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
    'e2e',
    'kernel-settlement',
    `e3-in-turn-correction-${scenario.name}`,
  );
  await recording.drain(
    query({
      prompt: PROMPT,
      options: {
        cwd: sandbox.workingDirectory,
        env: createSubscriptionEnvironment(sandbox.configDirectory),
        model: 'claude-sonnet-5',
        allowedTools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        outputFormat: { type: 'json_schema', schema: outputJsonSchema },
        maxTurns: 25,
        settingSources: [],
        ...(scenario.matcher
          ? {
              hooks: {
                PreToolUse: [
                  { matcher: scenario.matcher, hooks: [preToolUseHook] },
                ],
              },
            }
          : {}),
      },
    }),
  );

  const result = recording.onlyResultMessage();
  const structuredOutput = (
    result.subtype === 'success' ? result.structured_output : undefined
  ) as CarrierInput | null | undefined;
  const carrierToolUses = recording
    .toolUses()
    .filter((toolUse) => toolUse.name === CARRIER_TOOL);
  const evidence = [
    `subtype=${result.subtype} is_error=${result.is_error} num_turns=${result.num_turns}`,
    `carrierSubmissions=${carrierToolUses.length} hookCalls=${JSON.stringify(hookCalls.map((call) => call.decision))}`,
    `structured_output=${JSON.stringify(structuredOutput)}`,
    `cost=$${result.total_cost_usd.toFixed(4)}`,
    `see ${recording.logPath}`,
  ].join('; ');

  expect(
    recording.firstSystemInitMessage().tools,
    `'${CARRIER_TOOL}' is advertised in system/init.tools; ${evidence}`,
  ).toContain(CARRIER_TOOL);

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

describe('E3 — in-turn PreToolUse rejection over StructuredOutput', () => {
  it(scenarios.nativeSchemaRule.name, async () => {
    const run = await runScenario(scenarios.nativeSchemaRule);
    // The prompt asks for a descriptive sentence, so the first submission
    // breaks the pattern and the SDK itself re-prompts.
    expect(
      run.carrierToolUses.length,
      `the SDK re-prompted after a schema-invalid submission; ${run.evidence}`,
    ).toBeGreaterThanOrEqual(2);
    expect(run.result.subtype, run.evidence).toBe('success');
    expect(wordCount(run.structuredOutput?.summary), run.evidence).toBe(5);
    expect(run.structuredOutput?.totalBytes, run.evidence).toBe(
      EXPECTED_TOTAL_BYTES,
    );
  });

  it(scenarios.hookSchemaRule.name, async () => {
    const run = await runScenario(scenarios.hookSchemaRule);
    expect(
      new Set(run.hookCalls.map((call) => call.toolName)),
      `the hook sees the carrier under its emitted name; ${run.evidence}`,
    ).toEqual(new Set([CARRIER_TOOL]));
    expect(
      run.denials,
      `the rule was violated and denied in-turn; ${run.evidence}`,
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
    // A denial consistent with the declared contract is obeyed.
    expect(run.result.subtype, run.evidence).toBe('success');
    expect(wordCount(run.structuredOutput?.summary), run.evidence).toBe(5);
  });

  it(scenarios.hookOnlyRule.name, async () => {
    const run = await runScenario(scenarios.hookOnlyRule);
    expect(
      run.denials,
      `the cross-field rule was denied in-turn; ${run.evidence}`,
    ).toBeGreaterThanOrEqual(1);
    // Edge 1: a denial that contradicts the declared contract is argued with,
    // not obeyed. Edge 2: the loop then ends in a successful-looking result
    // with NO output — which the kernel must treat as OUTPUT_INVALID.
    expect(run.result.subtype, run.evidence).toBe('success');
    expect(run.result.is_error, run.evidence).toBe(false);
    expect(
      run.structuredOutput == null,
      `a denial loop ends in subtype success with no structured_output; ${run.evidence}`,
    ).toBe(true);
  });

  it(scenarios.hookUpdatedInput.name, async () => {
    const run = await runScenario(scenarios.hookUpdatedInput);
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

  it(scenarios.wrongMatcher.name, async () => {
    const run = await runScenario(scenarios.wrongMatcher);
    // Edge 3: no warning, no error — the hook simply never runs.
    expect(
      run.hookCalls,
      `a matcher naming no existing tool fires zero times; ${run.evidence}`,
    ).toEqual([]);
    expect(run.result.subtype, run.evidence).toBe('success');
    expect(run.result.is_error, run.evidence).toBe(false);
    expect(
      run.structuredOutput != null,
      `the run completed normally with its output; ${run.evidence}`,
    ).toBe(true);
  });
});
