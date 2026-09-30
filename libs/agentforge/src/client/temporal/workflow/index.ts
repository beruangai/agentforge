/**
 * `@beruangai/agentforge/temporal/workflow` — safe inside the workflow
 * sandbox: it imports only `@temporalio/workflow` at run time. A workflow
 * calls its connected agents' procedures through it, typed by their
 * contracts.
 */
export type { ActivityStart } from '../activity.ts';
export {
  DEFAULT_ACTIVITY_OPTIONS,
  proxyAgenticProject,
  type WorkflowCalls,
} from './proxy-agentic-project.ts';
