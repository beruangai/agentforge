import { implementAgent } from '@beruangai/agentforge/agent';
import { writer } from './contract.ts';

const os = implementAgent(writer);

/**
 * The writer agent's procedures. A handler runs the agent with
 * `context.runAgent`, its options composed over the base layer's:
 * `composeOptions(baseOptions(), { … })`, with `baseOptions` from
 * `@beruangai/golden-kata-base/options`.
 */
export const router = os.router({
  Write: os.Write.handler(async () => {
    throw new Error('not implemented: writer.Write');
  }),
});
