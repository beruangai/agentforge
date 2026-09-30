import type {
  InferSchemaInput,
  InferSchemaOutput,
  ProcedureContract,
  RouterContract,
} from '@orpc/contract';
import { type ActivityOptions, proxyActivities } from '@temporalio/workflow';
import type { ActivityStart } from '../activity.ts';

/** A contract's procedures as workflow calls: the input and that call's routing, to the typed output. */
export type WorkflowCalls<Contract> =
  Contract extends ProcedureContract<infer Input, infer Output, infer _Errors>
    ? (
        input: InferSchemaInput<Input>,
        start: ActivityStart,
      ) => Promise<InferSchemaOutput<Output>>
    : { readonly [Key in keyof Contract]: WorkflowCalls<Contract[Key]> };

/**
 * Merged under the caller's options. A heartbeat timeout of a minute sits
 * above the activity's 5 s poll heartbeat with room for a slow `GetTask`, so
 * a lost worker is noticed in about a minute; a day to close is only a
 * backstop, since the agent's time budget bounds the task and a longer
 * attempt merely attaches again.
 */
export const DEFAULT_ACTIVITY_OPTIONS = {
  heartbeatTimeout: '1 minute',
  startToCloseTimeout: '1 day',
} as const satisfies ActivityOptions;

type Activity = (input: unknown, start: ActivityStart) => Promise<unknown>;

/**
 * An agentic project's agents as workflow calls, typed by their contracts:
 * `proxyProject<typeof CONTRACTS>('goldenKata').writer.Write(input, start)`
 * schedules the activity `goldenKata.writer.Write`. Import the contracts as
 * types only, so the workflow bundle carries none of their code.
 */
export function proxyProject<
  Contracts extends Readonly<Record<string, RouterContract>>,
>(
  project: string,
  options: ActivityOptions = {},
): { readonly [Agent in keyof Contracts]: WorkflowCalls<Contracts[Agent]> } {
  const activities = proxyActivities<Record<string, Activity>>({
    ...DEFAULT_ACTIVITY_OPTIONS,
    ...options,
  });
  const node = (path: readonly string[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') {
          return undefined;
        }
        return node([...path, property]);
      },
      apply(_target, _this, [input, start]: [unknown, ActivityStart]) {
        const name = path.join('.');
        const activity = activities[name];
        if (activity === undefined) {
          throw new Error(`no activity '${name}'`);
        }
        return activity(input, start);
      },
    });
  return node([project]) as {
    readonly [Agent in keyof Contracts]: WorkflowCalls<Contracts[Agent]>;
  };
}
