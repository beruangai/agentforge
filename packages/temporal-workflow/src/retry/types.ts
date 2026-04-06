/**
 * Retry policy preset for use with Temporal's proxyActivities().
 * Spread directly into proxyActivities options.
 */
export interface RetryPreset {
  startToCloseTimeout: string;
  heartbeatTimeout?: string;
  retry: {
    initialInterval: string;
    backoffCoefficient: number;
    maximumInterval: string;
    maximumAttempts: number;
    nonRetryableErrorTypes: string[];
  };
}
