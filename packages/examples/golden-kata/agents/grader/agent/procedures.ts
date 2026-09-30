import { implementAgent } from '@beruangai/agentforge/agent';
import { grader } from './contract.ts';

const os = implementAgent(grader);

/**
 * The grader agent's procedures. A handler runs the agent with
 * `context.runAgent`, its options composed over the base layer's:
 * `composeOptions(baseOptions(), { … })`, with `baseOptions` from
 * `@beruangai/golden-kata-base/options`.
 */
export const router = os.router({
  Grade: os.Grade.handler(async () => {
    throw new Error('not implemented: grader.Grade');
  }),
});
