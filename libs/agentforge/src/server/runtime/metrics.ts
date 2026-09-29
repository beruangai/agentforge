import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  METRICS_DIMENSION,
  METRICS_NAMESPACE,
  METRICS_VARIABLE,
  type OperationalMetric,
} from '#core/metrics.ts';

export interface OperationalMetrics {
  /** Counts one occurrence, for the task it concerns. */
  count(metric: OperationalMetric, taskId: string): void;
  /** Settles every count still being published; before the container stops. */
  flush(): Promise<void>;
}

/**
 * Every count is a log line; where the construct names the runtime, it is
 * also published to CloudWatch (§REQ604). A count that cannot be published is
 * logged as an error: the task's outcome does not depend on it. The client
 * is made on the first count, after the V2 restore.
 */
export function createOperationalMetrics(
  environment: NodeJS.ProcessEnv = process.env,
  makeClient: () => Pick<CloudWatchClient, 'send'> = () =>
    new CloudWatchClient({}),
): OperationalMetrics {
  const runtimeName = environment[METRICS_VARIABLE];
  let client: Pick<CloudWatchClient, 'send'> | undefined;
  const pending = new Set<Promise<void>>();
  return {
    count(metric, taskId) {
      console.log(
        JSON.stringify({ event: 'agentforge.metric', metric, taskId }),
      );
      if (runtimeName === undefined || runtimeName === '') return;
      client ??= makeClient();
      const published = client
        .send(
          new PutMetricDataCommand({
            Namespace: METRICS_NAMESPACE,
            MetricData: [
              {
                MetricName: metric,
                Dimensions: [{ Name: METRICS_DIMENSION, Value: runtimeName }],
                Unit: 'Count',
                Value: 1,
              },
            ],
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => {
            console.error(
              `the ${metric} count for task ${taskId} could not be published`,
              error,
            );
          },
        )
        .finally(() => pending.delete(published));
      pending.add(published);
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}
