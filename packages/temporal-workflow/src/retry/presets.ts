import type { RetryPreset } from './types.js';
import { NON_RETRYABLE_ERROR_TYPES } from '../activity/error-classification.js';

const nonRetryableErrorTypes = [...NON_RETRYABLE_ERROR_TYPES];

/** Long-running tasks: deep research, complex analysis (10-15min) */
const longRunning: RetryPreset = {
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '2m',
    maximumAttempts: 3,
    nonRetryableErrorTypes,
  },
};

/** Standard tasks: typical agent work (5-10min) */
const standard: RetryPreset = {
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '2m',
    maximumAttempts: 2,
    nonRetryableErrorTypes,
  },
};

/** Quick tasks: lightweight, fast-completing work (2-5min) */
const quick: RetryPreset = {
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 2,
    nonRetryableErrorTypes,
  },
};

/** Create a custom preset by merging overrides with standard defaults */
function custom(overrides: Partial<RetryPreset>): RetryPreset {
  return {
    ...standard,
    ...overrides,
    retry: {
      ...standard.retry,
      ...overrides.retry,
    },
  };
}

/**
 * Named retry policy presets for Temporal activities.
 * Spread into proxyActivities() options.
 */
export const retryPresets = {
  longRunning,
  standard,
  quick,
  custom,
} as const;
