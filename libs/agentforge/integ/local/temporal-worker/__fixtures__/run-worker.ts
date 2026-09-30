/**
 * `runWorker` as a worker's entry runs it, in its own Node process, so a
 * signal reaches it as it would on ECS. Its one activity announces itself on
 * stdout and waits until it is cancelled.
 */
import { cancellationSignal } from '@temporalio/activity';
import { runWorker } from '../../../../src/client/temporal/worker.ts';

const workflowBundle = process.env.WORKFLOW_BUNDLE;
const taskQueue = process.env.TASK_QUEUE;
if (workflowBundle === undefined || taskQueue === undefined) {
  throw new Error('WORKFLOW_BUNDLE and TASK_QUEUE are required');
}

await runWorker({
  taskQueue,
  workflowBundle: new URL(`file://${workflowBundle}`),
  activities: {
    async waitForever() {
      process.stdout.write('activity started\n');
      const signal = cancellationSignal();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    },
  },
  agentActivities: {},
  requiredSecrets: [],
  shutdownGraceTime: '3s',
});
process.stdout.write('worker exited\n');
