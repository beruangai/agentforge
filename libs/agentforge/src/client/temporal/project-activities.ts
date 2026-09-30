import type { RouterContract } from '@orpc/contract';
import { listProcedures } from '#core/contract/procedures.ts';
import type { AgentForgeClient, ProcedureClient } from '../client.ts';
import { type ActivityStart, procedureActivity } from './activity.ts';

/** An activity as a worker registers it; its input is the procedure's. */
export type ProjectActivity = (
  input: never,
  start: ActivityStart,
) => Promise<unknown>;

/**
 * Every procedure of every agent of an agentic project as an activity named
 * `<project>.<agent>.<namespace…>.<Procedure>` — `goldenKata.writer.Write` —
 * each over that agent's procedure client, cancelling through its `CancelTask`.
 * Walks the contracts, not the client, whose proxies answer any name.
 */
export function projectActivities<
  Contracts extends Readonly<Record<string, RouterContract>>,
>(
  project: string,
  contracts: Contracts,
  client: {
    readonly [Agent in keyof Contracts]: AgentForgeClient<Contracts[Agent]>;
  },
  options: { readonly pollIntervalMilliseconds?: number } = {},
): Readonly<Record<string, ProjectActivity>> {
  const activities: Record<string, ProjectActivity> = {};
  for (const [agent, contract] of Object.entries(contracts)) {
    const agentClient = client[agent] as
      | AgentForgeClient<RouterContract>
      | undefined;
    if (agentClient === undefined) {
      throw new Error(
        `projectActivities('${project}'): no client for agent '${agent}'`,
      );
    }
    for (const { path } of listProcedures(contract)) {
      const procedure = path
        .split('.')
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          agentClient,
        ) as ProcedureClient<unknown, unknown> | undefined;
      if (typeof procedure?.SendMessage !== 'function') {
        throw new Error(
          `projectActivities('${project}'): agent '${agent}' has no client for procedure '${path}'`,
        );
      }
      activities[`${project}.${agent}.${path}`] = procedureActivity(procedure, {
        cancelTask: agentClient.CancelTask,
        ...options,
      });
    }
  }
  return activities;
}
