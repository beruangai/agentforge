/**
 * Dispatched work does not cost the final submission, under the kernel's own
 * configuration: streaming input and output, background work switched off per
 * query, the first result published and the input then ended
 * (docs/ARCHITECTURE.md §7).
 *
 * The kernel publishes the first result's `structured_output`. What it relies
 * on, and what this asserts, is that a turn which dispatches real work —
 * subagents, a long run of Bash calls — still ends in one result carrying a
 * schema-valid submission, and that with background work off none of that
 * work ran in the background, where its completion would start a second turn
 * and a second result (background-settlement.test.ts).
 *
 * Whether the model's answer is right is its own business and is not asserted;
 * AgentForge validates the shape, not the arithmetic.
 *
 * Findings: docs/research/kernel-settlement.md, "E1" and "The carrier tool is
 * real, and it is named `StructuredOutput`".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  backgroundWorkDisabled,
  carrierToolName,
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
  runWithStreamingInput,
} from '../../__fixtures__/claude-agent-sdk.ts';

const outputSchema = z.object({
  fileCount: z
    .number()
    .int()
    .describe('how many .txt files were found in the working directory'),
  totalBytes: z.number().int().describe('their combined size in bytes'),
  names: z.array(z.string()).describe('the file names, sorted'),
});

const outputJsonSchema = z.toJSONSchema(outputSchema, { target: 'draft-7' });

/** Something to dispatch work over. */
const fixtureFileSizes: Record<string, number> = {
  'a.txt': 10,
  'b.txt': 20,
  'c.txt': 30,
};

type Scenario = {
  name: string;
  prompt: string;
  allowedTools: string[];
  /**
   * The dispatch the scenario exists to exercise; without it, it tested
   * nothing. Fails loudly rather than passing an undispatched run.
   */
  assertDispatchHappened: (
    recording: QueryRecording,
    taskStartedMessages: SDKTaskStartedMessage[],
  ) => void;
};

const scenarios: Scenario[] = [
  {
    // Subagents run in the background by default since CLI 2.1.198; with
    // background work off, they must run in the foreground.
    name: 'subagents',
    prompt:
      'Use the Task tool to dispatch THREE separate general-purpose subagents, one per file (a.txt, b.txt, c.txt). ' +
      "Each subagent must report that file's exact byte size. Wait for all three, then report the combined result. " +
      'Do not do the work yourself.',
    allowedTools: ['Bash', 'Task', 'Read', 'Glob'],
    assertDispatchHappened: (recording, taskStartedMessages) => {
      const toolUseNames = recording.toolUseNames();
      // The allowlist name is `Task`; the emitted tool_use name is `Agent`.
      // Anything matched, counted or denied by name must use the emitted one.
      expect(
        toolUseNames.filter((name) => name === 'Task'),
        `no tool_use is emitted under the allowlist name \`Task\`; see ${recording.logPath}`,
      ).toEqual([]);
      expect(
        toolUseNames.filter((name) => name === 'Agent').length,
        `precondition: subagents were dispatched, as \`Agent\` tool_use blocks; tools used: ${JSON.stringify(toolUseNames)}; see ${recording.logPath}`,
      ).toBeGreaterThan(0);
      const subagentTasks = taskStartedMessages.filter(
        (message) => message.task_type === 'local_agent',
      );
      expect(
        subagentTasks.length,
        `precondition: each subagent registered as a task; see ${recording.logPath}`,
      ).toBeGreaterThan(0);
      // `is_backgrounded` is set for local_agent tasks, so an absent value is
      // drift worth being told about, not a pass.
      expect(
        subagentTasks.map((message) => message.is_backgrounded),
        `every subagent ran in the foreground; see ${recording.logPath}`,
      ).toEqual(subagentTasks.map(() => false));
    },
  },
  {
    // Many foreground tool calls in one turn, to push the turn long before it settles.
    name: 'bash-storm',
    prompt:
      'Run at least twelve separate Bash commands, one at a time, to inspect every .txt file in the current ' +
      'directory (ls, wc -c on each, cat on each, and a final ls -la). Do not combine them. Then report.',
    allowedTools: ['Bash'],
    assertDispatchHappened: (recording) => {
      expect(
        recording.toolUseNames().filter((name) => name === 'Bash').length,
        `precondition: the turn made at least twelve Bash calls; see ${recording.logPath}`,
      ).toBeGreaterThanOrEqual(12);
    },
  },
];

describe('a final submission survives dispatched work, with background work off', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const sandbox = createSandbox(`foreground-settlement-${scenario.name}`);
    onTestFinished(() => sandbox.dispose());
    for (const [name, size] of Object.entries(fixtureFileSizes)) {
      writeFileSync(join(sandbox.workingDirectory, name), 'x'.repeat(size));
    }

    const recording = new QueryRecording(
      'kernel-settlement',
      `foreground-settlement-${scenario.name}`,
    );
    await runWithStreamingInput(recording, scenario.prompt, {
      cwd: sandbox.workingDirectory,
      env: createSubscriptionEnvironment(
        sandbox.configDirectory,
        backgroundWorkDisabled,
      ),
      model: 'claude-sonnet-5',
      allowedTools: scenario.allowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: 'json_schema', schema: outputJsonSchema },
      maxTurns: 40,
      settingSources: [],
    });

    const toolUses = recording.toolUses();
    const evidence = `tools used: ${JSON.stringify(toolUses.map((toolUse) => toolUse.name))}; see ${recording.logPath}`;
    const taskStartedMessages = recording.messages.filter(
      (message): message is SDKTaskStartedMessage =>
        message.type === 'system' && message.subtype === 'task_started',
    );
    const taskUpdatedMessages = recording.messages.filter(
      (message): message is SDKTaskUpdatedMessage =>
        message.type === 'system' && message.subtype === 'task_updated',
    );

    expect(
      recording.firstSystemInitMessage().tools,
      'the carrier is advertised in system/init.tools, so the kernel can assert it at startup',
    ).toContain(carrierToolName);

    scenario.assertDispatchHappened(recording, taskStartedMessages);

    // Background work off: nothing registered in the background, nothing
    // moved there later, and a request for it — the model's choice — refused.
    expect(
      taskStartedMessages.filter((message) => message.is_backgrounded === true),
      `no task started in the background; ${evidence}`,
    ).toEqual([]);
    expect(
      taskUpdatedMessages.filter(
        (message) => message.patch.is_backgrounded === true,
      ),
      `no task moved to the background; ${evidence}`,
    ).toEqual([]);
    const backgroundRequestIds = toolUses
      .filter(
        (toolUse) =>
          (toolUse.name === 'Agent' || toolUse.name === 'Bash') &&
          (toolUse.input as { run_in_background?: unknown })
            .run_in_background !== undefined &&
          (toolUse.input as { run_in_background?: unknown })
            .run_in_background !== false,
      )
      .map((toolUse) => toolUse.id);
    const refusedToolUseIds = new Set(
      recording
        .toolResults()
        .filter((toolResult) => toolResult.isError)
        .map((toolResult) => toolResult.toolUseId),
    );
    expect(
      backgroundRequestIds.filter((id) => !refusedToolUseIds.has(id)),
      `every tool call that asked for run_in_background was refused; ${evidence}`,
    ).toEqual([]);

    // One result, read to process exit: nothing supersedes what the kernel
    // published.
    expect(
      recording.resultMessages(),
      `exactly one result, to process exit; ${evidence}`,
    ).toHaveLength(1);
    const result = recording.onlyResultMessage();
    expect(result.subtype, evidence).toBe('success');
    expect(result.is_error, evidence).toBe(false);
    // The SDK re-prompts a schema-invalid submission itself, so more than one
    // is legitimate.
    expect(
      toolUses.filter((toolUse) => toolUse.name === carrierToolName).length,
      `at least one ${carrierToolName} submission; ${evidence}`,
    ).toBeGreaterThanOrEqual(1);
    const structuredOutput =
      result.subtype === 'success' ? result.structured_output : undefined;
    expect(
      outputSchema.safeParse(structuredOutput).success,
      `structured_output survived and validates: ${JSON.stringify(structuredOutput)}; ${evidence}`,
    ).toBe(true);
  });
});
