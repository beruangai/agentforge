import { ApplicationFailure } from '@temporalio/common';

/** Error types that should not be retried by Temporal */
export const NON_RETRYABLE_ERROR_TYPES = [
  'SchemaValidationError',
  'PermissionDenied',
  'InvalidConfiguration',
] as const;

/**
 * Classify an error as a Temporal ApplicationFailure.
 * Returns retryable failures by default; only schema validation,
 * permission, and configuration errors are non-retryable.
 */
export function classifyError(error: unknown): ApplicationFailure {
  if (error instanceof ApplicationFailure) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Permission / credential errors
  if (/permission denied|unauthorized|forbidden|credentials?/i.test(message)) {
    return ApplicationFailure.nonRetryable(message, 'PermissionDenied');
  }

  // Invalid configuration
  if (/invalid config|missing required/i.test(message)) {
    return ApplicationFailure.nonRetryable(message, 'InvalidConfiguration');
  }

  // Everything else is retryable (container failures, timeouts, network errors, agent errors)
  return ApplicationFailure.retryable(message, 'AgentTaskError');
}
