/**
 * A task process for the executor's tests, run by Node as it is: it speaks
 * the task-process protocol by hand, scripted by its input's `script`, so a
 * test can make it misbehave in ways the harness never would.
 */
const send = (message: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('no IPC channel'));
      return;
    }
    process.send(message, undefined, {}, (error) =>
      error ? reject(error) : resolve(),
    );
  });

const completed = (output: unknown) => ({
  type: 'outcome',
  outcome: { state: 'TASK_STATE_COMPLETED', output },
});

interface ScriptedMessage {
  readonly type: string;
  readonly invocation?: { envelope: { input: { script: string } } };
}

let script: string | undefined;
process.on('message', async (message: ScriptedMessage) => {
  if (message.type === 'cancel') {
    if (script === 'WAIT') {
      // Swallows the cancel and answers as if it finished.
      await send(completed({ waited: false }));
      process.exit(0);
    }
    return;
  }
  if (script !== undefined || message.invocation === undefined) return;
  script = message.invocation.envelope.input.script;
  switch (script) {
    case 'REPORT':
      await send({
        type: 'record',
        record: { promptHash: 'hash', promptBytes: 1, options: {} },
      });
      await send(completed({ reported: true }));
      process.exit(0);
      break;
    case 'REPORT_AGENT_NAME':
      await send(completed({ agentName: process.env.AGENTFORGE_AGENT_NAME }));
      process.exit(0);
      break;
    case 'REPORT_THEN_LINGER':
      // Ignores any cancel, and exits on its own a moment after reporting.
      await send(completed({ reported: true }));
      process.stderr.write('scripted-task-process: reported\n');
      setTimeout(() => process.exit(0), 1_000);
      break;
    case 'SEND_GARBAGE':
      await send({ type: 'nonsense' });
      await send(completed({ reported: true }));
      process.exit(0);
      break;
    case 'WAIT':
    case 'IGNORE_CANCEL':
      setInterval(() => undefined, 60_000);
      break;
  }
});
