/**
 * DESIGN_OPTIONS §E, question 2:
 *   "With background work enabled, does a resumed turn still cancel its tool calls?"
 *
 * The predecessor harness kept everything in the foreground because a turn
 * resumed by background work cancelled its own final submission. The current
 * SDK has an explicit hold-back: a result produced while background work is
 * live is withheld until that work settles, and on a closed-input run the
 * tasks are then killed. This asks what that does to the `structured_output`
 * attachment.
 *
 * Three scenarios, all with background work genuinely running when the agent
 * submits:
 *   closed-input        — the string-prompt form (stdin closed), which is what
 *                         AgentForge's kernel would use.
 *   streaming-input     — the async-iterable form (stdin open), where a task
 *                         notification can resume the turn.
 *   background-disabled — CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, the control.
 *
 * Findings: docs/research/kernel-settlement.md, "E2".
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  query,
  type SDKResultMessage,
  type SDKTaskNotificationMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
} from '../../integ/__fixtures__/claude-agent-sdk.ts';

const OutputSchema = z.object({
  startedBackgroundWork: z
    .boolean()
    .describe('whether a background command was started'),
  note: z.string().describe('one sentence about what was started'),
});
const outputJsonSchema = z.toJSONSchema(OutputSchema, { target: 'draft-7' });

// The agent must background something that outlives its own submission, so the
// hold-back (if any) is observable rather than raced.
const PROMPT =
  'Using the Bash tool with run_in_background set to true, start this exact command: ' +
  '`sleep 25 && echo finished > background-done.txt`. ' +
  'Do NOT wait for it and do NOT poll it. The moment the tool returns, immediately give your ' +
  'final structured output saying you started it. Speed matters more than completeness.';

const BACKGROUND_MARKER_FILE = 'background-done.txt';
const CARRIER_TOOL = 'StructuredOutput';

/**
 * Stdin stays open until `release` is called, which is what distinguishes an
 * open-input session from `-p`. The test releases it once the first result
 * lands, plus a grace window in which a task notification could still resume
 * the turn.
 */
function streamingPrompt(text: string): {
  prompt: AsyncIterable<SDKUserMessage>;
  release: () => void;
} {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  async function* generator(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    await released;
  }
  return { prompt: generator(), release };
}

type Scenario = {
  name: 'closed-input' | 'streaming-input' | 'background-disabled';
  streaming: boolean;
  disableBackgroundTasks: boolean;
};

const scenarios: Scenario[] = [
  { name: 'closed-input', streaming: false, disableBackgroundTasks: false },
  { name: 'streaming-input', streaming: true, disableBackgroundTasks: false },
  {
    name: 'background-disabled',
    streaming: false,
    disableBackgroundTasks: true,
  },
];

function validStructuredOutput(result: SDKResultMessage): boolean {
  return (
    result.subtype === 'success' &&
    OutputSchema.safeParse(result.structured_output).success
  );
}

describe('E2 — background work and the resumed turn', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const sandbox = createSandbox(`e2-${scenario.name}`);
    onTestFinished(() => sandbox.dispose());
    const backgroundMarker = join(
      sandbox.workingDirectory,
      BACKGROUND_MARKER_FILE,
    );

    const streaming = scenario.streaming ? streamingPrompt(PROMPT) : undefined;
    const startedAt = Date.now();
    let submittedAtMilliseconds: number | undefined;
    let firstResultAtMilliseconds: number | undefined;

    const recording = new QueryRecording(
      'e2e',
      'kernel-settlement',
      `e2-background-settlement-${scenario.name}`,
    );
    await recording.drain(
      query({
        prompt: streaming ? streaming.prompt : PROMPT,
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(
            sandbox.configDirectory,
            scenario.disableBackgroundTasks
              ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
              : {},
          ),
          model: 'claude-sonnet-5',
          allowedTools: ['Bash'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          outputFormat: { type: 'json_schema', schema: outputJsonSchema },
          maxTurns: 12,
          settingSources: [],
        },
      }),
      (message) => {
        if (
          message.type === 'assistant' &&
          submittedAtMilliseconds === undefined
        ) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.name === CARRIER_TOOL) {
              submittedAtMilliseconds = Date.now() - startedAt;
            }
          }
        }
        if (
          message.type === 'result' &&
          firstResultAtMilliseconds === undefined
        ) {
          firstResultAtMilliseconds = Date.now() - startedAt;
          // A streaming-input session never ends on its own. Hold it open past
          // the result, so a task notification still has a turn to resume;
          // then close stdin so the run can end.
          if (streaming) setTimeout(streaming.release, 20_000);
        }
      },
    );

    // Did the backgrounded command live long enough to write its marker?
    const markerExistsAfterRun = existsSync(backgroundMarker);
    // Give it the rest of its 25 s to tell killed from merely unfinished.
    await delay(Math.max(0, 28_000 - (Date.now() - startedAt)));
    const markerExistsAfter28Seconds = existsSync(backgroundMarker);

    const results = recording.resultMessages();
    const taskNotifications = recording.messages.filter(
      (message): message is SDKTaskNotificationMessage =>
        message.type === 'system' && message.subtype === 'task_notification',
    );
    const toolUses = recording.toolUses();
    const backgroundedBash = toolUses.filter(
      (toolUse) =>
        toolUse.name === 'Bash' &&
        (toolUse.input as { run_in_background?: unknown }).run_in_background ===
          true,
    );
    const evidence = [
      `results=${results.length} submitted@${submittedAtMilliseconds ?? '-'}ms firstResult@${firstResultAtMilliseconds ?? '-'}ms`,
      `taskNotifications=${JSON.stringify(taskNotifications.map((notification) => notification.status))}`,
      `marker: afterRun=${markerExistsAfterRun} after28s=${markerExistsAfter28Seconds}`,
      `see ${recording.logPath}`,
    ].join('; ');

    expect(
      backgroundedBash.length,
      `the agent attempted a Bash call with run_in_background: true; without it the scenario tested nothing; ${evidence}`,
    ).toBeGreaterThan(0);

    if (scenario.name === 'closed-input') {
      expect(
        results,
        `closed input yields exactly one result; ${evidence}`,
      ).toHaveLength(1);
      const result = recording.onlyResultMessage();
      expect(result.is_error, evidence).toBe(false);
      expect(
        validStructuredOutput(result),
        `structured_output present and valid; ${evidence}`,
      ).toBe(true);
      // Hold-back tasks are killed when the held result is released: with
      // stdin closed, a stop_task control could never be delivered.
      expect(
        taskNotifications.map((notification) => notification.status),
        `the background task is killed at the result; ${evidence}`,
      ).toEqual(['stopped']);
      expect(markerExistsAfterRun, evidence).toBe(false);
      expect(
        markerExistsAfter28Seconds,
        `the killed command never wrote its marker; ${evidence}`,
      ).toBe(false);
    }

    if (scenario.name === 'streaming-input') {
      // The completing task's notification starts a whole new turn, with a
      // second system/init, which submits again and publishes a second result.
      // Neither is cancelled; a consumer keeping the last result it sees ships
      // an answer to a question nobody asked.
      expect(
        results,
        `open input yields a second result; ${evidence}`,
      ).toHaveLength(2);
      const [firstResult, secondResult] = results as [
        SDKResultMessage,
        SDKResultMessage,
      ];
      for (const result of [firstResult, secondResult]) {
        expect(result.subtype, evidence).toBe('success');
        expect(result.is_error, evidence).toBe(false);
        expect(
          validStructuredOutput(result),
          `both results carry valid structured_output; ${evidence}`,
        ).toBe(true);
      }
      const firstResultIndex = recording.messages.indexOf(firstResult);
      const secondResultIndex = recording.messages.indexOf(secondResult);
      const between = recording.messages.slice(
        firstResultIndex + 1,
        secondResultIndex,
      );
      expect(
        between.some(
          (message) =>
            message.type === 'system' &&
            message.subtype === 'task_notification' &&
            message.status === 'completed',
        ),
        `a completed task_notification arrives between the two results; ${evidence}`,
      ).toBe(true);
      expect(
        between.some(
          (message) => message.type === 'system' && message.subtype === 'init',
        ),
        `the resumed turn opens with a second system/init; ${evidence}`,
      ).toBe(true);
      expect(
        markerExistsAfter28Seconds,
        `the background command completed; ${evidence}`,
      ).toBe(true);
    }

    if (scenario.name === 'background-disabled') {
      expect(results, `exactly one result; ${evidence}`).toHaveLength(1);
      const result = recording.onlyResultMessage();
      expect(result.is_error, evidence).toBe(false);
      expect(
        validStructuredOutput(result),
        `structured_output present and valid; ${evidence}`,
      ).toBe(true);
      // A genuine kill switch rather than a policy: the parameter is removed
      // from the Bash tool's schema, so the attempt fails input validation.
      const toolResults = recording.toolResults();
      for (const toolUse of backgroundedBash) {
        const toolResult = toolResults.find(
          (candidate) => candidate.toolUseId === toolUse.id,
        );
        expect(
          toolResult?.isError,
          `the run_in_background attempt is refused; ${evidence}`,
        ).toBe(true);
        expect(toolResult?.text, evidence).toContain(
          'An unexpected parameter `run_in_background` was provided',
        );
      }
    }
  });
});
