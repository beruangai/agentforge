/**
 * DESIGN_OPTIONS §E, question 1:
 *   "Does a final structured-output submission survive dispatched work in the foreground?"
 *
 * The predecessor harness kept every dispatched unit of work in the foreground
 * because a turn resumed by background work once cancelled its own final
 * submission (D9). This asks whether the foreground rule still buys anything:
 * run a query whose turn dispatches real work — subagents through Task, and a
 * batch of Bash calls — and see whether the `structured_output` attachment
 * still arrives, validated, on the result.
 *
 * Run: bun kernel-settlement/e1-foreground-settlement.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadEnvironment, createSandbox, record, writeLog, finding, reportFindings } from '../harness.ts';

loadEnvironment();

const OutputSchema = z.object({
  fileCount: z.number().int().describe('how many .txt files were found in the working directory'),
  totalBytes: z.number().int().describe('their combined size in bytes'),
  names: z.array(z.string()).describe('the file names, sorted'),
});

const schema = z.toJSONSchema(OutputSchema, { target: 'draft-7' });

type Scenario = {
  name: string;
  prompt: string;
  allowedTools: string[];
};

const scenarios: Scenario[] = [
  {
    // No dispatch at all — the control. If this fails, nothing below means anything.
    name: 'control-no-dispatch',
    prompt:
      'There are .txt files in the current directory. Use Bash with `ls` and `wc -c` to count them and total their bytes, then report.',
    allowedTools: ['Bash'],
  },
  {
    // Foreground dispatch through subagents: the shape D9 was written about.
    name: 'foreground-subagents',
    prompt:
      'Use the Task tool to dispatch THREE separate general-purpose subagents, one per file (a.txt, b.txt, c.txt). ' +
      'Each subagent must report that file\'s exact byte size. Wait for all three, then report the combined result. ' +
      'Do not do the work yourself and do not background anything.',
    allowedTools: ['Bash', 'Task', 'Read', 'Glob'],
  },
  {
    // Many foreground tool calls in one turn, to push the turn long before it settles.
    name: 'foreground-tool-storm',
    prompt:
      'Run at least twelve separate Bash commands, one at a time, to inspect every .txt file in the current ' +
      'directory (ls, wc -c on each, cat on each, and a final ls -la). Do not combine them. Then report.',
    allowedTools: ['Bash'],
  },
];

async function runScenario(scenario: Scenario) {
  const sandbox = createSandbox(`e1-${scenario.name}`);
  // Deterministic, known-answer fixture: 3 files, 10 + 20 + 30 bytes.
  const fixture: Record<string, number> = { 'a.txt': 10, 'b.txt': 20, 'c.txt': 30 };
  for (const [name, size] of Object.entries(fixture)) {
    await Bun.write(`${sandbox.workingDirectory}/${name}`, 'x'.repeat(size));
  }

  const backgroundEvents: unknown[] = [];

  const run = await record(
    query({
      prompt: scenario.prompt,
      options: {
        cwd: sandbox.workingDirectory,
        env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox.configDirectory },
        model: 'claude-sonnet-5',
        allowedTools: scenario.allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        outputFormat: { type: 'json_schema', schema },
        maxTurns: 40,
        settingSources: [],
      },
    }),
    (message) => {
      if (message.type === 'system' && String(message.subtype).includes('background')) {
        backgroundEvents.push(message);
      }
    },
  );

  writeLog(`e1-${scenario.name}`, run);

  const result = run.result as any;
  const structured = result?.structured_output;
  const parsed = structured ? OutputSchema.safeParse(structured) : undefined;
  const expectedTotal = Object.values(fixture).reduce((a, b) => a + b, 0);

  // The allowlist name is `Task`; the emitted tool_use name is `Agent`. Count both.
  const taskCalls = run.toolNames.filter((n) => n === 'Task' || n === 'Agent').length;
  const carrierCalls = run.toolNames.filter((n) => n === 'StructuredOutput').length;
  const detail = [
    `subtype=${result?.subtype}`,
    `is_error=${result?.is_error}`,
    `num_turns=${result?.num_turns}`,
    `tools=${run.toolNames.length} (subagents=${taskCalls}, StructuredOutput=${carrierCalls})`,
    `structured_output=${structured ? 'present' : 'ABSENT'}`,
    `valid=${parsed ? parsed.success : 'n/a'}`,
    parsed?.success
      ? `values: fileCount=${parsed.data.fileCount} totalBytes=${parsed.data.totalBytes} (expected 3 / ${expectedTotal})`
      : parsed
        ? `zod: ${JSON.stringify(parsed.error.issues).slice(0, 300)}`
        : '',
    `backgroundEvents=${backgroundEvents.length}`,
    `cost=$${(result?.total_cost_usd ?? 0).toFixed(4)} duration=${(run.durationMs / 1000).toFixed(1)}s`,
  ]
    .filter(Boolean)
    .join('\n');

  const survived = Boolean(structured) && parsed?.success === true && result?.is_error !== true;
  finding(`E1 ${scenario.name}`, survived ? 'SURVIVED' : 'LOST', detail);

  sandbox.dispose();
  return { scenario: scenario.name, survived, costUsd: result?.total_cost_usd ?? 0, taskCalls };
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

reportFindings();
console.log(
  `total spike cost: $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(4)}`,
);
await Bun.write(
  `${import.meta.dir}/../out/e1-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
