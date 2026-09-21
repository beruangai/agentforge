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
 * Run: bun kernel-settlement/e3-in-turn-correction.ts [scenario...]
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadEnvironment, createSandbox, record, writeLog, finding, reportFindings } from '../harness.ts';

loadEnvironment();

const CARRIER_TOOL = 'StructuredOutput';

/** Fixture sizes chosen so the sum is not a round number the model can guess. */
const FIXTURE: Record<string, number> = { 'alpha.txt': 137, 'beta.txt': 2891, 'gamma.txt': 15043 };
const EXPECTED_TOTAL = Object.values(FIXTURE).reduce((a, b) => a + b, 0); // 18071

const base = {
  files: z
    .array(z.object({ name: z.string(), bytes: z.number().int() }))
    .describe('every .txt file in the working directory, with its exact byte size'),
  totalBytes: z.number().int().describe('the total size'),
  summary: z.string().describe('a short summary'),
};

/** Exactly five words. Expressible in draft-07, so native re-prompting can enforce it. */
const FIVE_WORDS = '^\\S+(?: \\S+){4}$';

const PROMPT =
  'Use Bash to list every .txt file in the current directory and get each one\'s exact byte size. ' +
  'Then give your final structured output: every file with its size, the total, and a summary. ' +
  'Write the summary as a normal descriptive sentence.';

type HookCall = { toolName: string; decision: string; reason?: string };

type Scenario = {
  name: string;
  /** Adds the five-word rule to the schema, so the SDK enforces it natively. */
  ruleInSchema: boolean;
  matcher?: string;
  /** Returns a denial reason, or undefined to allow. */
  check?: (input: any) => string | undefined;
  /** Returns a repaired input, or undefined to leave it alone. */
  repair?: (input: any) => Record<string, unknown> | undefined;
};

const wordCount = (s: unknown) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

const scenarios: Scenario[] = [
  { name: 'native-schema-rule', ruleInSchema: true },
  {
    name: 'hook-schema-rule',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    check: (input) =>
      wordCount(input?.summary) === 5
        ? undefined
        : `The "summary" field must be EXACTLY five words. You wrote ${wordCount(input?.summary)}. Resubmit with a five-word summary.`,
  },
  {
    name: 'hook-only-rule',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    // Cross-field AND unstated in the prompt or the schema: draft-07 cannot
    // express it, and the model cannot guess it, so the denial path is
    // guaranteed to be exercised rather than merely available.
    check: (input) => {
      const sum = (input?.files ?? []).reduce((a: number, f: any) => a + (f?.bytes ?? 0), 0);
      const required = Math.ceil(sum / 1024);
      if (input?.totalBytes === required) return undefined;
      return (
        `"totalBytes" must be the total expressed in WHOLE KILOBYTES, rounded up — not bytes. ` +
        `The files sum to ${sum} bytes, so totalBytes must be ${required}. You submitted ${input?.totalBytes}. Resubmit.`
      );
    },
  },
  {
    name: 'hook-updated-input',
    ruleInSchema: false,
    matcher: CARRIER_TOOL,
    repair: (input) => {
      const words = String(input?.summary ?? '').trim().split(/\s+/).filter(Boolean);
      if (words.length === 5) return undefined;
      return { ...input, summary: words.slice(0, 5).join(' ') || 'repaired by the harness hook' };
    },
  },
  {
    // Plural. Names no tool that exists. Must fire zero times.
    name: 'wrong-matcher',
    ruleInSchema: false,
    matcher: 'StructuredOutputs',
    check: () => 'this hook should never have fired',
  },
];

async function runScenario(scenario: Scenario) {
  const sandbox = createSandbox(`e3-${scenario.name}`);
  for (const [name, size] of Object.entries(FIXTURE)) {
    await Bun.write(`${sandbox.workingDirectory}/${name}`, 'x'.repeat(size));
  }

  const OutputSchema = z.object({
    ...base,
    summary: scenario.ruleInSchema
      ? z.string().regex(new RegExp(FIVE_WORDS)).describe('a summary of exactly five words')
      : base.summary,
  });
  const schema = z.toJSONSchema(OutputSchema, { target: 'draft-7', io: 'input' });

  const hookCalls: HookCall[] = [];
  let denials = 0;
  let repairs = 0;

  const hooks = scenario.matcher
    ? {
        PreToolUse: [
          {
            matcher: scenario.matcher,
            hooks: [
              async (input: any) => {
                const toolName = input.tool_name;
                if (scenario.repair) {
                  const updated = scenario.repair(input.tool_input);
                  hookCalls.push({ toolName, decision: updated ? 'updatedInput' : 'allow' });
                  if (updated) repairs += 1;
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'allow' as const,
                      ...(updated ? { updatedInput: updated } : {}),
                    },
                  };
                }
                // Cap the correction loop: a rule the model cannot satisfy must
                // not spin forever at the operator's expense.
                const reason = denials >= 3 ? undefined : scenario.check?.(input.tool_input);
                hookCalls.push({ toolName, decision: reason ? 'deny' : 'allow', reason });
                if (reason) denials += 1;
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: (reason ? 'deny' : 'allow') as 'deny' | 'allow',
                    ...(reason ? { permissionDecisionReason: reason } : {}),
                  },
                };
              },
            ],
          },
        ],
      }
    : undefined;

  const run = await record(
    query({
      prompt: PROMPT,
      options: {
        cwd: sandbox.workingDirectory,
        env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox.configDirectory },
        model: 'claude-sonnet-5',
        allowedTools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        outputFormat: { type: 'json_schema', schema },
        maxTurns: 25,
        settingSources: [],
        ...(hooks ? { hooks } : {}),
      },
    }),
  );

  writeLog(`e3-${scenario.name}`, run);
  const result = run.result as any;
  const structured = result?.structured_output;
  const carrierSubmissions = run.toolNames.filter((n) => n === CARRIER_TOOL).length;

  const carrierAdvertised = ((run.systemInit as any)?.tools ?? []).includes(CARRIER_TOOL);
  const sum = (structured?.files ?? []).reduce((a: number, f: any) => a + (f?.bytes ?? 0), 0);
  const summaryWords = wordCount(structured?.summary);

  const detail = [
    `subtype=${result?.subtype} is_error=${result?.is_error} num_turns=${result?.num_turns}`,
    `structured_output=${structured ? 'present' : 'ABSENT'}`,
    `carrier submissions=${carrierSubmissions}  hookCalls=${hookCalls.length} (denials=${denials}, repairs=${repairs})`,
    `hook saw tools: [${[...new Set(hookCalls.map((c) => c.toolName))].join(', ') || 'none'}]`,
    `'${CARRIER_TOOL}' advertised in init.tools = ${carrierAdvertised}`,
    `final summary = ${JSON.stringify(structured?.summary)} (${summaryWords} words)`,
    `final totalBytes = ${structured?.totalBytes}; sum(files)=${sum}; truth=${EXPECTED_TOTAL}`,
    `cost=$${(result?.total_cost_usd ?? 0).toFixed(4)} duration=${(run.durationMs / 1000).toFixed(1)}s`,
  ].join('\n');

  finding(`E3 ${scenario.name}`, structured ? 'RAN' : 'NO-OUTPUT', detail);

  sandbox.dispose();
  return {
    scenario: scenario.name,
    carrierSubmissions,
    hookCalls: hookCalls.length,
    denials,
    repairs,
    carrierAdvertised,
    summaryWords,
    totalBytes: structured?.totalBytes,
    sumOfFiles: sum,
    numTurns: result?.num_turns,
    subtype: result?.subtype,
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: run.durationMs,
  };
}

const only = process.argv.slice(2);
const selected = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
const results = [];
for (const scenario of selected) {
  try {
    results.push(await runScenario(scenario));
  } catch (error) {
    finding(`E3 ${scenario.name}`, 'THREW', String(error).slice(0, 600));
  }
}
reportFindings();
await Bun.write(
  `${import.meta.dir}/../out/e3-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
