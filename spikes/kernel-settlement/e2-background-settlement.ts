/**
 * DESIGN_OPTIONS §E, question 2:
 *   "With background work enabled, does a resumed turn still cancel its tool calls?"
 *
 * D9: the predecessor harness kept everything in the foreground because a turn
 * resumed by background work cancelled its own final submission. The current SDK
 * has an explicit hold-back: a result produced while background work is live is
 * withheld until that work settles, and on a closed-input run the tasks are then
 * killed. This asks what that does to the `structured_output` attachment.
 *
 * Three scenarios, all with background work genuinely running when the agent
 * submits:
 *   closed-input   — the string-prompt form (stdin closed), which is what
 *                    AgentForge's kernel would use.
 *   streaming-input — the async-iterable form (stdin open), where a task
 *                    notification can resume the turn.
 *   disabled        — CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, the control.
 *
 * Run: bun kernel-settlement/e2-background-settlement.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadEnvironment, createSandbox, record, writeLog, finding, reportFindings } from '../harness.ts';

loadEnvironment();

const OutputSchema = z.object({
  startedBackgroundWork: z.boolean().describe('whether a background command was started'),
  note: z.string().describe('one sentence about what was started'),
});
const schema = z.toJSONSchema(OutputSchema, { target: 'draft-7' });

// The agent must background something that outlives its own submission, so the
// hold-back (if any) is observable rather than raced.
const PROMPT =
  'Using the Bash tool with run_in_background set to true, start this exact command: ' +
  '`sleep 25 && echo finished > background-done.txt`. ' +
  'Do NOT wait for it and do NOT poll it. The moment the tool returns, immediately give your ' +
  'final structured output saying you started it. Speed matters more than completeness.';

/**
 * Stdin stays open until `close` resolves, which is what distinguishes an
 * open-input session from `-p`. The consumer resolves it once the result lands,
 * plus a grace window in which a task notification could still resume the turn.
 */
function streamingPrompt(text: string) {
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* generator() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: text },
      parent_tool_use_id: null,
      session_id: '',
    };
    await closed;
  }
  return { generator: generator(), release };
}

type Scenario = { name: string; streaming: boolean; disableBackground: boolean };

const all: Scenario[] = [
  { name: 'closed-input', streaming: false, disableBackground: false },
  { name: 'streaming-input', streaming: true, disableBackground: false },
  { name: 'background-disabled', streaming: false, disableBackground: true },
];
const only = process.argv.slice(2);
const scenarios = only.length ? all.filter((s) => only.includes(s.name)) : all;

async function runScenario(scenario: Scenario) {
  const sandbox = createSandbox(`e2-${scenario.name}`);
  const marker = `${sandbox.workingDirectory}/background-done.txt`;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: sandbox.configDirectory,
  };
  if (scenario.disableBackground) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';

  const taskEvents: { at: number; subtype: string }[] = [];
  const started = Date.now();
  let submittedAt: number | undefined;
  let resultAt: number | undefined;

  const streaming = scenario.streaming ? streamingPrompt(PROMPT) : undefined;

  const iterator = query({
    prompt: streaming ? streaming.generator : PROMPT,
    options: {
      cwd: sandbox.workingDirectory,
      env,
      model: 'claude-sonnet-5',
      allowedTools: ['Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: 'json_schema', schema },
      maxTurns: 12,
      settingSources: [],
    },
  });

  // A streaming-input session never ends on its own; stop it once the result lands.
  const run = await record(iterator, (message) => {
    if (message.type === 'system') taskEvents.push({ at: Date.now() - started, subtype: message.subtype });
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'StructuredOutput') submittedAt = Date.now() - started;
      }
    }
    if (message.type === 'result' && resultAt === undefined) {
      resultAt = Date.now() - started;
      // Hold the session open past the result, so a task notification still has
      // a turn to resume; then close stdin so the run can end.
      if (streaming) setTimeout(streaming.release, 20_000);
    }
  });

  writeLog(`e2-${scenario.name}`, run);
  const result = run.result as any;
  const structured = result?.structured_output;
  const parsed = structured ? OutputSchema.safeParse(structured) : undefined;

  // Did the backgrounded command live long enough to write its marker?
  const markerExistsAtResult = await Bun.file(marker).exists();
  // Give it the rest of its 25s to see whether it was killed or merely unfinished.
  await new Promise((r) => setTimeout(r, Math.max(0, 28_000 - (Date.now() - started))));
  const markerExistsLater = await Bun.file(marker).exists();

  const backgroundSubtypes = taskEvents
    .filter((e) => /background|task/.test(e.subtype))
    .map((e) => `${e.subtype}@${e.at}ms`);

  const detail = [
    `subtype=${result?.subtype} is_error=${result?.is_error} num_turns=${result?.num_turns}`,
    `structured_output=${structured ? 'present' : 'ABSENT'} valid=${parsed ? parsed.success : 'n/a'}`,
    `submitted@${submittedAt ?? '-'}ms  result@${resultAt ?? '-'}ms  heldBack=${
      submittedAt !== undefined && resultAt !== undefined ? `${resultAt - submittedAt}ms` : 'n/a'
    }`,
    `backgroundCommandFinished: atResult=${markerExistsAtResult} after28s=${markerExistsLater}`,
    `taskEvents=[${backgroundSubtypes.join(', ') || 'none'}]`,
    `cost=$${(result?.total_cost_usd ?? 0).toFixed(4)}`,
  ].join('\n');

  const survived = Boolean(structured) && parsed?.success === true && result?.is_error !== true;
  finding(`E2 ${scenario.name}`, survived ? 'SURVIVED' : 'LOST', detail);

  sandbox.dispose();
  return {
    scenario: scenario.name,
    survived,
    submittedAt,
    resultAt,
    heldBackMs: submittedAt !== undefined && resultAt !== undefined ? resultAt - submittedAt : null,
    backgroundCommandFinishedAtResult: markerExistsAtResult,
    backgroundCommandFinishedLater: markerExistsLater,
    costUsd: result?.total_cost_usd ?? 0,
  };
}

const results = [];
for (const scenario of scenarios) {
  try {
    results.push(await runScenario(scenario));
  } catch (error) {
    finding(`E2 ${scenario.name}`, 'THREW', String(error).slice(0, 500));
    results.push({ scenario: scenario.name, survived: false, error: String(error).slice(0, 500) });
  }
}

reportFindings();
await Bun.write(
  `${import.meta.dir}/../out/e2-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
