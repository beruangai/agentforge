/**
 * DESIGN_OPTIONS §E, question 1:
 *   "Does a final structured-output submission survive dispatched work in the foreground?"
 *
 * The predecessor harness kept every dispatched unit of work in the foreground
 * because a turn resumed by background work once cancelled its own final
 * submission. This asks whether the foreground rule still buys anything: run a
 * query whose turn dispatches real work — subagents through Task, and a batch
 * of Bash calls — and see whether the `structured_output` attachment still
 * arrives, validated, on the result.
 *
 * Findings: docs/research/kernel-settlement.md, "E1" and "The carrier tool is
 * real, and it is named `StructuredOutput`".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
} from '../../integ/__fixtures__/claude-agent-sdk.ts';

const OutputSchema = z.object({
  fileCount: z
    .number()
    .int()
    .describe('how many .txt files were found in the working directory'),
  totalBytes: z.number().int().describe('their combined size in bytes'),
  names: z.array(z.string()).describe('the file names, sorted'),
});

const outputJsonSchema = z.toJSONSchema(OutputSchema, { target: 'draft-7' });

/** Deterministic, known-answer fixture, so a wrong answer is distinguishable from a lost one. */
const fixtureFileSizes: Record<string, number> = {
  'a.txt': 10,
  'b.txt': 20,
  'c.txt': 30,
};

const CARRIER_TOOL = 'StructuredOutput';

type Scenario = {
  name: string;
  prompt: string;
  allowedTools: string[];
  /** The dispatch the scenario exists to exercise; without it, it tested nothing. */
  assertDispatchHappened: (toolUseNames: string[]) => void;
};

const scenarios: Scenario[] = [
  {
    // No dispatch at all — the control. If this fails, nothing below means anything.
    name: 'control-no-dispatch',
    prompt:
      'There are .txt files in the current directory. Use Bash with `ls` and `wc -c` to count them and total their bytes, then report.',
    allowedTools: ['Bash'],
    assertDispatchHappened: (toolUseNames) => {
      expect(
        toolUseNames.filter((name) => name === 'Agent' || name === 'Task'),
        'the control dispatches no subagent',
      ).toEqual([]);
    },
  },
  {
    // Foreground dispatch through subagents: the shape the foreground rule was written about.
    name: 'foreground-subagents',
    prompt:
      'Use the Task tool to dispatch THREE separate general-purpose subagents, one per file (a.txt, b.txt, c.txt). ' +
      "Each subagent must report that file's exact byte size. Wait for all three, then report the combined result. " +
      'Do not do the work yourself and do not background anything.',
    allowedTools: ['Bash', 'Task', 'Read', 'Glob'],
    assertDispatchHappened: (toolUseNames) => {
      // The allowlist name is `Task`; the emitted tool_use name is `Agent`.
      // Anything matched, counted or denied by name must use the emitted one.
      expect(
        toolUseNames.filter((name) => name === 'Task'),
        'no tool_use is emitted under the allowlist name `Task`',
      ).toEqual([]);
      expect(
        toolUseNames.filter((name) => name === 'Agent').length,
        `subagents are emitted as \`Agent\` tool_use blocks; tools used: ${JSON.stringify(toolUseNames)}`,
      ).toBeGreaterThan(0);
    },
  },
  {
    // Many foreground tool calls in one turn, to push the turn long before it settles.
    name: 'foreground-tool-storm',
    prompt:
      'Run at least twelve separate Bash commands, one at a time, to inspect every .txt file in the current ' +
      'directory (ls, wc -c on each, cat on each, and a final ls -la). Do not combine them. Then report.',
    allowedTools: ['Bash'],
    assertDispatchHappened: (toolUseNames) => {
      expect(
        toolUseNames.filter((name) => name === 'Bash').length,
        'the turn made at least twelve sequential Bash calls',
      ).toBeGreaterThanOrEqual(12);
    },
  },
];

describe('E1 — a final submission survives dispatched work in the foreground', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const sandbox = createSandbox(`e1-${scenario.name}`);
    onTestFinished(() => sandbox.dispose());
    for (const [name, size] of Object.entries(fixtureFileSizes)) {
      writeFileSync(join(sandbox.workingDirectory, name), 'x'.repeat(size));
    }

    const recording = new QueryRecording(
      'e2e',
      'kernel-settlement',
      `e1-foreground-settlement-${scenario.name}`,
    );
    await recording.drain(
      query({
        prompt: scenario.prompt,
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: 'claude-sonnet-5',
          allowedTools: scenario.allowedTools,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          outputFormat: { type: 'json_schema', schema: outputJsonSchema },
          maxTurns: 40,
          settingSources: [],
        },
      }),
    );

    const systemInit = recording.firstSystemInitMessage();
    const toolUseNames = recording.toolUseNames();
    const evidence = `tools used: ${JSON.stringify(toolUseNames)}; see ${recording.logPath}`;

    expect(
      systemInit.tools,
      'the carrier is advertised in system/init.tools, so its existence is assertable at startup',
    ).toContain(CARRIER_TOOL);
    // allowedTools is a permission allowlist, not a tool-exposure filter.
    expect(
      systemInit.tools.filter(
        (tool) =>
          tool !== CARRIER_TOOL && !scenario.allowedTools.includes(tool),
      ).length,
      `allowedTools does not narrow what system/init advertises; advertised: ${JSON.stringify(systemInit.tools)}`,
    ).toBeGreaterThan(0);

    scenario.assertDispatchHappened(toolUseNames);

    expect(
      recording.resultMessages(),
      `exactly one result; ${evidence}`,
    ).toHaveLength(1);
    const result = recording.onlyResultMessage();
    expect(result.subtype, evidence).toBe('success');
    expect(result.is_error, evidence).toBe(false);
    expect(
      toolUseNames.filter((name) => name === CARRIER_TOOL),
      `exactly one ${CARRIER_TOOL} submission; ${evidence}`,
    ).toHaveLength(1);

    const structuredOutput =
      result.subtype === 'success' ? result.structured_output : undefined;
    const parsed = OutputSchema.safeParse(structuredOutput);
    expect(
      parsed.success,
      `structured_output survived and validates: ${JSON.stringify(structuredOutput)}`,
    ).toBe(true);
    expect(parsed.data, 'the known-answer fixture').toEqual({
      fileCount: 3,
      totalBytes: 60,
      names: ['a.txt', 'b.txt', 'c.txt'],
    });
  });
});
