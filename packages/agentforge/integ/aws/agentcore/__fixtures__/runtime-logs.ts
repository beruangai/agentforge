import {
  type CloudWatchLogsClient,
  paginateDescribeLogGroups,
  paginateFilterLogEvents,
} from '@aws-sdk/client-cloudwatch-logs';
import { vi } from 'vitest';
import {
  type ContainerLogEventName,
  type ContainerLogEventNamed,
  ContainerLogEventSchema,
} from './container-log-events.ts';

/**
 * AgentCore writes a runtime's container stdout to
 * `/aws/bedrock-agentcore/runtimes/<agentRuntimeId>-<endpoint>`, created when
 * the first container logs.
 */
export function runtimeLogGroupNamePrefix(agentRuntimeId: string): string {
  return `/aws/bedrock-agentcore/runtimes/${agentRuntimeId}`;
}

export interface ContainerLogQuery<Name extends ContainerLogEventName> {
  readonly agentRuntimeId: string;
  readonly eventName: Name;
  /** Epoch milliseconds; events before it are not read. */
  readonly startTime: number;
  /** Only this container's events, when given. */
  readonly containerId?: string;
}

/**
 * Reads the container's own JSON events for one runtime, validated against the
 * schema the container writes them with. No log group yet means no container
 * has logged yet: that reads as no events, and a caller waiting for events
 * keeps waiting. A matched line that is not a valid event throws.
 */
export async function readContainerLogEvents<
  Name extends ContainerLogEventName,
>(
  logs: CloudWatchLogsClient,
  query: ContainerLogQuery<Name>,
): Promise<ContainerLogEventNamed<Name>[]> {
  const filterPattern =
    query.containerId === undefined
      ? `{ $.event = "${query.eventName}" }`
      : `{ ($.event = "${query.eventName}") && ($.containerId = "${query.containerId}") }`;
  const events: ContainerLogEventNamed<Name>[] = [];
  for await (const groupPage of paginateDescribeLogGroups(
    { client: logs },
    { logGroupNamePrefix: runtimeLogGroupNamePrefix(query.agentRuntimeId) },
  )) {
    for (const { logGroupName } of groupPage.logGroups ?? []) {
      if (logGroupName === undefined) {
        throw new Error('DescribeLogGroups returned a group with no name');
      }
      for await (const page of paginateFilterLogEvents(
        { client: logs },
        { logGroupName, startTime: query.startTime, filterPattern },
      )) {
        for (const logEvent of page.events ?? []) {
          const parsed = ContainerLogEventSchema.safeParse(
            JSON.parse(logEvent.message ?? 'null'),
          );
          if (!parsed.success || parsed.data.event !== query.eventName) {
            throw new Error(
              `${logGroupName} matched "${filterPattern}" with a line that is not a ${query.eventName} event: ${logEvent.message}`,
            );
          }
          events.push(parsed.data as ContainerLogEventNamed<Name>);
        }
      }
    }
  }
  return events;
}

/**
 * Polls until `satisfied` holds for the events read so far. CloudWatch ingests
 * with a delay of seconds, so an assertion on container logs waits for them;
 * on timeout it throws with what it last saw rather than a bare "timed out".
 */
export async function waitForContainerLogEvents<
  Name extends ContainerLogEventName,
>(
  logs: CloudWatchLogsClient,
  query: ContainerLogQuery<Name>,
  satisfied: (events: ContainerLogEventNamed<Name>[]) => boolean,
  timeoutMilliseconds: number,
): Promise<ContainerLogEventNamed<Name>[]> {
  let lastRead: ContainerLogEventNamed<Name>[] = [];
  try {
    return await vi.waitUntil(
      async () => {
        lastRead = await readContainerLogEvents(logs, query);
        return satisfied(lastRead) ? lastRead : false;
      },
      { timeout: timeoutMilliseconds, interval: 5_000 },
    );
  } catch (error) {
    throw new Error(
      `container log events never satisfied the condition within ${timeoutMilliseconds} ms (${JSON.stringify(query)}); last read ${lastRead.length}: ${JSON.stringify(lastRead).slice(0, 2_000)}`,
      { cause: error },
    );
  }
}
