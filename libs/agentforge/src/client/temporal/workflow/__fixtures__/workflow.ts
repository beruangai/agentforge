import { workflowInfo } from '@temporalio/workflow';
import { proxyAgenticProject } from '../index.ts';
import type { CONTRACTS } from './contract.ts';

const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata');

export async function writeAndGrade(topic: string): Promise<number> {
  const runtimeSessionId = workflowInfo().workflowId;
  const { kata } = await goldenKata.writer.Write(
    { topic },
    { runtimeSessionId },
  );
  const { score } = await goldenKata.grader.rubric.Grade(
    { kata },
    { runtimeSessionId },
  );
  return score;
}
