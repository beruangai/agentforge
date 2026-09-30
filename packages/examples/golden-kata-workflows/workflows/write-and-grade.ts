import type {
  Inputs as GoldenKataInputs,
  Outputs as GoldenKataOutputs,
} from '@beruangai/golden-kata/client';
import { workflowInfo } from '@temporalio/workflow';
import { resolveAgents } from '../agents/workflow.ts';

const agents = resolveAgents();

export interface WrittenAndGraded {
  readonly written: GoldenKataOutputs['writer']['Write'];
  readonly grade: GoldenKataOutputs['grader']['Grade'];
}

/**
 * A kata written by one agent and graded by another, each call in the
 * workflow's own runtime session.
 */
export async function writeAndGrade(
  input: GoldenKataInputs['writer']['Write'],
): Promise<WrittenAndGraded> {
  const runtimeSessionId = workflowInfo().workflowId;
  const written = await agents.goldenKata.writer.Write(input, {
    runtimeSessionId,
  });
  const grade = await agents.goldenKata.grader.Grade(
    { kata: written.kata },
    { runtimeSessionId },
  );
  return { written, grade };
}
