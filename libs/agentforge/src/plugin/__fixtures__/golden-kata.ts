import { AGENT_GENERATOR, type AgenticProject } from '../project-record.ts';

/** An agentic project with two agents, as its record reads. */
export const GOLDEN_KATA: AgenticProject = {
  name: '@proj/golden-kata',
  root: 'packages/golden-kata',
  packageName: '@proj/golden-kata',
  projectName: 'golden-kata',
  scope: 'proj',
  agents: [
    {
      generator: AGENT_GENERATOR,
      name: 'writer',
      path: 'agents/writer',
      runtimeConfigKey: 'GoldenKataWriter',
      containerName: 'proj-golden-kata-writer',
    },
    {
      generator: AGENT_GENERATOR,
      name: 'grader',
      path: 'agents/grader',
      runtimeConfigKey: 'GoldenKataGrader',
      containerName: 'proj-golden-kata-grader',
    },
  ],
  detached: { files: [], targets: [] },
};
