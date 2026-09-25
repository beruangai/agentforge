/**
 * With background work ON, a background completion starts a new turn and
 * publishes a second result — the drift detector for the reason the kernel
 * switches background work off (docs/ARCHITECTURE.md §7).
 *
 * The kernel runs in streaming input and output with
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. This runs the same input mode
 * with the switch left off, has the agent background a command that outlives
 * its own submission, and holds the input open until the second result. If the
 * SDK stops starting a turn on a background completion — or starts marking it
 * differently — this is what says so, and it feeds the open question of
 * whether background work can be allowed with a deterministic final answer
 * (docs/DESIGN_OPTIONS.md §E).
 *
 * The assertions are structural and hold whether the model's answers are
 * right or wrong: two results, the second from a task notification. Closed
 * input is not tested — the kernel never uses it.
 *
 * Findings: docs/research/kernel-settlement.md, "E2".
 */
import type {
  SDKResultMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  CARRIER_TOOL_NAME,
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
  runWithStreamingInput,
} from '../../__fixtures__/claude-agent-sdk.ts';

const OutputSchema = z.object({
  startedBackgroundWork: z
    .boolean()
    .describe('whether a background command was started'),
  note: z.string().describe('one sentence about what was started'),
});
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(OutputSchema, { target: 'draft-7' });

// The agent must background something that outlives its own submission, so
// its completion arrives after the first result rather than racing it.
const PROMPT =
  'Using the Bash tool with run_in_background set to true, start this exact command: ' +
  '`sleep 25 && echo finished > background-done.txt`. ' +
  'Do NOT wait for it and do NOT poll it. The moment the tool returns, immediately give your ' +
  'final structured output saying you started it. Speed matters more than completeness.';

/**
 * How long after the first result to wait for the second before ending the
 * input anyway. The command sleeps 25 s from before the first result, so this
 * is generous; expiring it fails the test with the recording as evidence.
 */
const SECOND_RESULT_DEADLINE_MILLISECONDS = 90_000;

describe('with background work on, a background completion publishes a second result', () => {
  it('streaming-input', async () => {
    const sandbox = createSandbox('background-settlement-streaming-input');
    onTestFinished(() => sandbox.dispose());

    const startedAt = Date.now();
    let resultCount = 0;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    onTestFinished(() => clearTimeout(deadlineTimer));

    const recording = new QueryRecording(
      'kernel-settlement',
      'background-settlement-streaming-input',
    );
    await runWithStreamingInput(
      recording,
      PROMPT,
      {
        cwd: sandbox.workingDirectory,
        env: createSubscriptionEnvironment(sandbox.configDirectory),
        model: 'claude-sonnet-5',
        allowedTools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        outputFormat: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
        maxTurns: 12,
        settingSources: [],
      },
      (message, endInput) => {
        if (message.type !== 'result') return;
        resultCount += 1;
        if (resultCount === 1) {
          deadlineTimer = setTimeout(() => {
            deadlineExpired = true;
            endInput();
          }, SECOND_RESULT_DEADLINE_MILLISECONDS);
        }
        if (resultCount === 2) {
          clearTimeout(deadlineTimer);
          endInput();
        }
      },
    );

    const results = recording.resultMessages();
    const firstResultIndex =
      results[0] === undefined ? -1 : recording.messages.indexOf(results[0]);
    const backgroundedTasks = recording.messages.filter(
      (message): message is SDKTaskStartedMessage =>
        message.type === 'system' &&
        message.subtype === 'task_started' &&
        message.is_backgrounded === true,
    );
    const taskNotifications = recording.messages.filter(
      (message): message is SDKTaskNotificationMessage =>
        message.type === 'system' && message.subtype === 'task_notification',
    );
    const evidence = [
      `results=${results.length} origins=${JSON.stringify(results.map((result) => result.origin ?? null))}`,
      `backgroundedTasks=${backgroundedTasks.length}`,
      `taskNotifications=${JSON.stringify(taskNotifications.map((notification) => notification.status))}`,
      `carrierSubmissions=${recording.toolUseNames().filter((name) => name === CARRIER_TOOL_NAME).length}`,
      `deadlineExpired=${deadlineExpired} elapsed=${Date.now() - startedAt}ms`,
      `see ${recording.logPath}`,
    ].join('; ');

    // Preconditions — the model's choices the scenario depends on. Without
    // them it tested nothing, and it fails saying so.
    expect(
      firstResultIndex,
      `precondition: the run published a result; ${evidence}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      backgroundedTasks.filter(
        (task) => recording.messages.indexOf(task) < firstResultIndex,
      ).length,
      `precondition: the agent started background work before its first result; ${evidence}`,
    ).toBeGreaterThan(0);
    expect(
      taskNotifications.filter(
        (notification) =>
          recording.messages.indexOf(notification) < firstResultIndex,
      ),
      `precondition: the background work was still live when the first result was published; ${evidence}`,
    ).toEqual([]);

    // The drift detector.
    expect(
      deadlineExpired,
      `the second result arrived within ${SECOND_RESULT_DEADLINE_MILLISECONDS} ms of the first; ${evidence}`,
    ).toBe(false);
    expect(
      results,
      `open input yields a second result; ${evidence}`,
    ).toHaveLength(2);
    const [firstResult, secondResult] = results as [
      SDKResultMessage,
      SDKResultMessage,
    ];
    expect(
      secondResult.origin?.kind,
      `the second result is marked as started by a task notification; ${evidence}`,
    ).toBe('task-notification');
    expect(
      recording.messages
        .slice(
          recording.messages.indexOf(firstResult) + 1,
          recording.messages.indexOf(secondResult),
        )
        .some(
          (message) =>
            message.type === 'system' &&
            message.subtype === 'task_notification' &&
            message.status === 'completed',
        ),
      `a completed task_notification arrives between the two results; ${evidence}`,
    ).toBe(true);
  });
});
