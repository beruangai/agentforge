/** Where Strands keeps a session in the agent's storage, beneath the agent's name: `session/<sessionId>/`. */
export function sessionPrefix(sessionId: string): string {
  return `session/${sessionId}/`;
}

/** The latest snapshot of a session's agent, as Strands' session manager writes it. */
export function latestSnapshotKey(sessionId: string): string {
  return `${sessionPrefix(sessionId)}scopes/agent/agent/snapshots/snapshot_latest.json`;
}
