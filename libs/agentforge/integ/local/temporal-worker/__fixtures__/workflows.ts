import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import { proxyAgenticProject } from '../../../../src/client/temporal/workflow/index.ts';
import type { CONTRACTS } from './contract.ts';

/** A lost worker's attempt is retried within seconds, not the minute the default allows. */
const fixture = proxyAgenticProject<typeof CONTRACTS>('fixture', {
  heartbeatTimeout: '10 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 1 },
});

export async function callAgent(text: string): Promise<string> {
  return fixture.agent.Run(
    { text },
    { runtimeSessionId: workflowInfo().workflowId },
  );
}

const { waitForever } = proxyActivities<{ waitForever(): Promise<void> }>({
  startToCloseTimeout: '1 hour',
});

export async function waitOnAnActivity(): Promise<void> {
  await waitForever();
}
