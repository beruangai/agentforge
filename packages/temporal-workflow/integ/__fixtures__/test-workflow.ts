/**
 * Simple test workflow used by TestWorkflowEnvironment integration tests.
 * This file is bundled by Temporal's workflow bundler.
 */
import { proxyActivities } from '@temporalio/workflow';

interface TestActivities {
  analyzeData(input: { dataPath: string }): Promise<{ summary: string; score: number }>;
}

const activities = proxyActivities<TestActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
});

export async function testAnalysisWorkflow(input: {
  dataPath: string;
}): Promise<{ summary: string; score: number }> {
  return activities.analyzeData(input);
}
