import { workflowInfo } from '@temporalio/workflow';
import { agents } from '../agents/workflow.ts';

const { goldenKata } = agents();

type Write = typeof goldenKata.writer.Write;
export type WriteInput = Parameters<Write>[0];
export type Written = Awaited<ReturnType<Write>>;
export type Grade = Awaited<ReturnType<typeof goldenKata.grader.Grade>>;

export interface WrittenAndGraded {
  readonly written: Written;
  readonly grade: Grade;
}

/**
 * A kata written by one agent and graded by another, each call in the
 * workflow's own runtime session.
 */
export async function writeAndGrade(
  input: WriteInput,
): Promise<WrittenAndGraded> {
  const runtimeSessionId = workflowInfo().workflowId;
  const written = await goldenKata.writer.Write(input, { runtimeSessionId });
  const grade = await goldenKata.grader.Grade(
    { kata: written.kata },
    { runtimeSessionId },
  );
  return { written, grade };
}
