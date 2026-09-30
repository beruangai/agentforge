/**
 * `@beruangai/agentforge/temporal` — the caller's side of the boundary, over
 * the client: a procedure as an activity, an agentic project's procedures as
 * a worker's activities, the worker itself and its connection. Nothing below
 * the client knows a caller exists.
 */
export {
  type ActivityStart,
  type ProcedureActivityOptions,
  procedureActivity,
} from './activity.ts';
export {
  type AgentsSetting,
  agentsFromEnvironment,
  connectTemporalClient,
  temporalConnectConfig,
} from './connection.ts';
export {
  type ProjectActivity,
  projectActivities,
} from './project-activities.ts';
export { type RunWorkerOptions, runWorker } from './worker.ts';
