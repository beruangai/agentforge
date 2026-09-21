/**
 * DESIGN_OPTIONS §E, question 4:
 *   "Does every option set — maxTurns among them — actually reach and bind the run?"
 *
 * ARCHITECTURE.md D5 already promises a test that every resolved key reaches
 * `query()`. That is cheap and proves nothing about the SDK. This asks the
 * harder half: does the SDK then BIND the option — is there an observable
 * consequence? Each case sets one option to a value whose effect is visible,
 * and asserts the effect rather than the argument.
 *
 * Each case is deliberately the cheapest run that can show the effect.
 *
 * Run: bun kernel-settlement/e4-option-binding.ts [case...]
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadEnvironment, createSandbox, record, writeLog, finding, reportFindings } from '../harness.ts';

loadEnvironment();

const Trivial = z.object({ answer: z.string() });
const schema = z.toJSONSchema(Trivial, { target: 'draft-7' });

type Case = {
  name: string;
  option: string;
  /** What binding looks like, in one line. */
  expectation: string;
  prompt: string;
  options: Record<string, unknown>;
  /** Returns [bound, evidence]. */
  assess: (run: any, sandbox: { workingDirectory: string }, threw?: string) => Promise<[boolean, string]>;
};

const cases: Case[] = [
  {
    name: 'maxTurns',
    option: 'maxTurns',
    expectation: "run stops with subtype 'error_max_turns' before finishing",
    prompt:
      'Run these Bash commands ONE AT A TIME, never combined, waiting for each: ' +
      '`echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`, `echo 7`, `echo 8`. Then answer "done".',
    options: { maxTurns: 2, allowedTools: ['Bash'] },
    assess: async (run, _s, threw) => {
      const s = run?.result?.subtype;
      if (threw) return [/maximum number of turns/i.test(threw), `THREW: ${threw}`];
      return [s === 'error_max_turns', `subtype=${s} num_turns=${run?.result?.num_turns}`];
    },
  },
  {
    name: 'maxBudgetUsd',
    option: 'maxBudgetUsd',
    expectation: "run stops with subtype 'error_max_budget_usd'",
    prompt:
      'Run these Bash commands ONE AT A TIME, never combined: ' +
      Array.from({ length: 25 }, (_, i) => `\`echo ${i}\``).join(', ') +
      '. Then answer "done".',
    options: { maxBudgetUsd: 0.02, allowedTools: ['Bash'], maxTurns: 60 },
    assess: async (run, _s, threw) => {
      const s = run?.result?.subtype;
      if (threw) return [/maximum budget/i.test(threw), `THREW: ${threw}`];
      return [
        s === 'error_max_budget_usd',
        `subtype=${s} cost=$${(run?.result?.total_cost_usd ?? 0).toFixed(4)} (cap $0.02)`,
      ];
    },
  },
  {
    name: 'model',
    option: 'model',
    expectation: 'init and result report the model that was asked for',
    prompt: 'Answer with the single word: ok',
    options: { model: 'claude-haiku-4-5-20251001' },
    assess: async (run) => {
      const asked = 'haiku';
      const initModel = String(run.systemInit?.model ?? '');
      const resultModel = String(run.result?.modelUsage ? Object.keys(run.result.modelUsage).join(',') : '');
      return [
        initModel.includes(asked) || resultModel.includes(asked),
        `init.model=${initModel} modelUsage=[${resultModel}]`,
      ];
    },
  },
  {
    name: 'disallowedTools',
    option: 'disallowedTools',
    expectation: 'the denied tool is never successfully used',
    prompt: 'Use the Bash tool to run `echo hello`. If you cannot, say why in your answer.',
    options: { disallowedTools: ['Bash'], allowedTools: ['Bash'], maxTurns: 6 },
    assess: async (run) => {
      const bashUses = run.toolNames.filter((n: string) => n === 'Bash').length;
      return [bashUses === 0, `Bash tool_use blocks emitted = ${bashUses}`];
    },
  },
  {
    name: 'cwd',
    option: 'cwd',
    expectation: 'the run reads the sandbox working directory, not the process one',
    prompt: 'Use Bash to `cat marker.txt` in the current directory, and put its exact contents in your answer.',
    options: { allowedTools: ['Bash'], maxTurns: 8 },
    assess: async (run) => {
      const answer = String((run.result?.structured_output as any)?.answer ?? '');
      return [answer.includes('SANDBOX-MARKER'), `answer=${JSON.stringify(answer).slice(0, 160)}`];
    },
  },
  {
    name: 'systemPrompt',
    option: 'systemPrompt',
    expectation: 'a custom system prompt changes behaviour observably',
    prompt: 'What is 2 + 2?',
    options: { systemPrompt: 'You must answer every question with exactly the word BANANA and nothing else.' },
    assess: async (run) => {
      const answer = String((run.result?.structured_output as any)?.answer ?? '');
      return [answer.toUpperCase().includes('BANANA'), `answer=${JSON.stringify(answer).slice(0, 120)}`];
    },
  },
  {
    name: 'settingSources-empty',
    option: 'settingSources: []',
    expectation: 'no project CLAUDE.md is loaded into the run',
    prompt: 'Answer with the secret word from your instructions, or "none" if you were given no secret word.',
    options: { settingSources: [] },
    assess: async (run) => {
      const answer = String((run.result?.structured_output as any)?.answer ?? '').toUpperCase();
      return [!answer.includes('PINEAPPLE'), `answer=${JSON.stringify(answer).slice(0, 120)}`];
    },
  },
  {
    name: 'settingSources-project',
    option: "settingSources: ['project']",
    expectation: 'the project CLAUDE.md IS loaded — the control for the case above',
    prompt: 'Answer with the secret word from your instructions, or "none" if you were given no secret word.',
    options: { settingSources: ['project'] },
    assess: async (run) => {
      const answer = String((run.result?.structured_output as any)?.answer ?? '').toUpperCase();
      return [answer.includes('PINEAPPLE'), `answer=${JSON.stringify(answer).slice(0, 120)}`];
    },
  },
  {
    name: 'unknown-option',
    option: 'thisOptionDoesNotExist',
    expectation:
      'an option the SDK does not know is REJECTED, not silently dropped (the D5 failure mode)',
    prompt: 'Answer with the single word: ok',
    options: { thisOptionDoesNotExist: 'surely-this-throws', maxTurns: 3 },
    assess: async (run) => {
      // Binding here means "the SDK complained". Reaching a result means it did not.
      return [false, `run completed normally: subtype=${run.result?.subtype} — the unknown key was ignored`];
    },
  },
];

async function runCase(testCase: Case) {
  const sandbox = createSandbox(`e4-${testCase.name}`);
  await Bun.write(`${sandbox.workingDirectory}/marker.txt`, 'SANDBOX-MARKER');
  // A project CLAUDE.md, so settingSources can be shown to bind in both directions.
  await Bun.write(
    `${sandbox.workingDirectory}/CLAUDE.md`,
    '# Project instructions\n\nYour secret word is PINEAPPLE. When asked for the secret word, answer PINEAPPLE.\n',
  );

  let threw: string | undefined;
  let run: any;
  // Some limits bind by THROWING out of the iterator rather than by yielding a
  // result message. That is itself the finding, so it is assessed, not swallowed.
  try {
    run = await record(
      query({
        prompt: testCase.prompt,
        options: {
          cwd: sandbox.workingDirectory,
          env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox.configDirectory },
          model: 'claude-sonnet-5',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          outputFormat: { type: 'json_schema', schema },
          ...(testCase.options as any),
        },
      }),
    );
    writeLog(`e4-${testCase.name}`, run);
  } catch (error) {
    threw = String(error).slice(0, 300);
  }

  let bound = false;
  let evidence = threw ? `threw: ${threw}` : 'no result';
  if (threw && testCase.name === 'unknown-option') {
    bound = true; // Throwing is exactly the desired behaviour here.
  } else {
    [bound, evidence] = await testCase.assess(run, sandbox, threw);
  }

  finding(
    `E4 ${testCase.option}`,
    bound ? 'BINDS' : 'DOES-NOT-BIND',
    `expected: ${testCase.expectation}\nobserved: ${evidence}\ncost=$${(run?.result?.total_cost_usd ?? 0).toFixed(4)}`,
  );

  sandbox.dispose();
  return {
    option: testCase.option,
    bound,
    evidence,
    costUsd: run?.result?.total_cost_usd ?? 0,
  };
}

const only = process.argv.slice(2);
const selected = only.length ? cases.filter((c) => only.includes(c.name)) : cases;
const results = [];
for (const testCase of selected) results.push(await runCase(testCase));
reportFindings();
console.log(`total: $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(4)}`);
await Bun.write(
  `${import.meta.dir}/../out/e4-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
