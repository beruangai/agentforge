import { proxyActivities } from '@temporalio/workflow';
import type { activities } from '../activities/index.ts';

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

/**
 * A placeholder: replace it with the project's workflows, which call the
 * connected agents through `agents()` from `../agents/workflow.ts`.
 */
export async function example(name: string): Promise<string> {
  return greet(name);
}
