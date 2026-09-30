import type {
  InferSchemaInput,
  InferSchemaOutput,
  ProcedureContract,
  RouterContract,
} from '@orpc/contract';
import { type ActivityOptions, proxyActivities } from '@temporalio/workflow';
import type { ActivityStart } from '../activity.ts';

const REFUSED_ACTIVITY_OPTIONS = ['activityId', 'taskQueue'] as const;

/**
 * What an agent call may set, at the set or the call: every activity option
 * but `activityId` and `taskQueue`. The activity keys its task by the
 * workflow run and the activity id, so a shared id would attach a second call
 * to the first call's task and return its output; and only the project's own
 * queue has a worker registering the agents' activities, so another queue
 * would wait forever.
 */
export type AgentActivityOptions = Omit<
  ActivityOptions,
  (typeof REFUSED_ACTIVITY_OPTIONS)[number]
>;

/**
 * A contract's procedures as workflow calls: the input, that call's routing
 * and, optionally, its activity options over the set's, to the typed output.
 */
export type WorkflowCalls<Contract> =
  Contract extends ProcedureContract<infer Input, infer Output, infer _Errors>
    ? (
        input: InferSchemaInput<Input>,
        start: ActivityStart,
        options?: AgentActivityOptions,
      ) => Promise<InferSchemaOutput<Output>>
    : { readonly [Key in keyof Contract]: WorkflowCalls<Contract[Key]> };

/** Throws naming each refused option, which a cast would get past the type. */
function refuseSharedOptions(options: object, where: string): void {
  const refused = REFUSED_ACTIVITY_OPTIONS.filter((name) => name in options);
  if (refused.length > 0) {
    throw new TypeError(
      `${where} sets ${refused.join(' and ')}, which an agent call may not: the activity id keys the agent's task, and only the project's own task queue has a worker for its activities`,
    );
  }
}

/**
 * Merged under the caller's options. A heartbeat timeout of a minute sits
 * above the activity's 5 s poll heartbeat with room for a slow `GetTask`, so
 * a lost worker is noticed in about a minute; a day to close is only a
 * backstop, since the agent's time budget bounds the task and a longer
 * attempt merely attaches again.
 *
 * `WAIT_CANCELLATION_COMPLETED` keeps a cancelled workflow open until the
 * activity has cancelled its task. An unset cancellation type is sent as
 * `TRY_CANCEL` (SDK 1.24.0, whatever its documentation says): the workflow
 * closes at once, the activity then finds itself gone rather than cancelled,
 * and the task runs on to its time budget. A caller overriding it to
 * `TRY_CANCEL` or `ABANDON` gives up cancelling the task.
 */
export const DEFAULT_ACTIVITY_OPTIONS = {
  heartbeatTimeout: '1 minute',
  startToCloseTimeout: '1 day',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
} as const satisfies ActivityOptions;

type Activities = Record<
  string,
  (input: unknown, start: ActivityStart) => Promise<unknown>
>;

/**
 * An agentic project's agents as workflow calls, typed by their contracts:
 * `proxyAgenticProject<typeof CONTRACTS>('goldenKata').writer.Write(input, start)`
 * schedules the activity `goldenKata.writer.Write`. `options` are the set's,
 * over AgentForge's defaults; a call's own, its third argument, are merged
 * over them for that call alone. Import the contracts as types only, so the
 * workflow bundle carries none of their code.
 */
export function proxyAgenticProject<
  Contracts extends Readonly<Record<string, RouterContract>>,
>(
  project: string,
  options: AgentActivityOptions = {},
): { readonly [Agent in keyof Contracts]: WorkflowCalls<Contracts[Agent]> } {
  refuseSharedOptions(options, `the ${project} agents' options`);
  const setOptions = { ...DEFAULT_ACTIVITY_OPTIONS, ...options };
  const activities = proxyActivities<Activities>(setOptions);
  const node = (path: readonly string[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') {
          return undefined;
        }
        return node([...path, property]);
      },
      apply(
        _target,
        _this,
        [input, start, callOptions]: [
          unknown,
          ActivityStart,
          AgentActivityOptions | undefined,
        ],
      ) {
        const name = path.join('.');
        let scheduling = activities;
        if (callOptions !== undefined) {
          refuseSharedOptions(callOptions, `the call to ${name}`);
          scheduling = proxyActivities<Activities>({
            ...setOptions,
            ...callOptions,
          });
        }
        const activity = scheduling[name];
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
