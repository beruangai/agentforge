/**
 * What AgentForge cannot rule out and counts per agent (§REQ604), in the
 * CloudWatch namespace the construct grants and charts. Shared by the
 * runtime, which counts, and the construct, which grants and charts, so the
 * two cannot drift.
 */
export const METRICS_NAMESPACE = 'AgentForge';
/** The dimension every count carries: the runtime's name, as AgentCore's own metrics name it. */
export const METRICS_DIMENSION = 'AgentRuntimeName';
/** Set by the construct to the runtime's name; unset, counts are logged but not published. */
export const METRICS_VARIABLE = 'AGENTFORGE_METRICS_RUNTIME_NAME';

export const OPERATIONAL_METRICS = {
  /** A task still running when its container was stopped; recorded `LOST` by the container. */
  STOPPED_MID_TURN: 'TasksStoppedMidTurn',
  /** A stopping task that did not end within its grace period, and was killed. */
  KILLED_AFTER_GRACE: 'TasksKilledAfterGrace',
  /** A task found `LOST` by its lapsed lease: its container died, or was killed inside its grace window. */
  LOST: 'TasksLost',
  /** An outcome the task store refused or failed to write. */
  OUTCOME_UNRECORDED: 'OutcomesUnrecorded',
} as const;

export type OperationalMetric =
  (typeof OPERATIONAL_METRICS)[keyof typeof OPERATIONAL_METRICS];
