import type {
  Framework,
  FrameworkRunner,
} from '../../../server/harness/framework.ts';
import { claudeAgentOptionsMiddleware } from './agent-options.ts';
import {
  type ClaudeTypes,
  type KernelContext,
  type QueryFunction,
  runAgent,
} from './kernel.ts';
import { sessionStoreFromEnvironment } from './session-store.ts';

/**
 * The runner a `claude` task process runs its agent runs through: the
 * kernel, over the deployment's session store. `query` replaces the SDK call,
 * a test seam.
 */
export function claudeRunner(
  options: Pick<KernelContext, 'sessionStore'> & {
    readonly query?: QueryFunction;
  } = {},
): FrameworkRunner<ClaudeTypes> {
  return {
    runAgent: (spec, environment) =>
      runAgent(
        spec,
        {
          ...environment,
          ...(options.sessionStore === undefined
            ? {}
            : { sessionStore: options.sessionStore }),
        },
        options.query,
      ),
  };
}

/** The Claude Agent SDK, as a framework (ADR 0021). */
export const framework: Framework<ClaudeTypes> = {
  name: 'claude',
  prepare: () => {
    const sessionStore = sessionStoreFromEnvironment();
    return claudeRunner(sessionStore === undefined ? {} : { sessionStore });
  },
  agentOptionsMiddleware: claudeAgentOptionsMiddleware,
};
