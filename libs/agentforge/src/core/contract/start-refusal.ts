import { z } from 'zod';

/**
 * A start a container cannot run now, answered in-band — a JSON-RPC error on
 * HTTP 200 — since AgentCore turns any other status into an opaque 424 and
 * passes no header back. No task is created and no idempotency key bound, so
 * the same start, repeated after `retryAfterSeconds`, runs as a first start.
 * What can never succeed stays a `TASK_STATE_REJECTED` task.
 */
export const START_REFUSALS = [
  /** The container is stopping; the session's next call reaches a fresh one. */
  'CONTAINER_STOPPING',
  /** The container runs as many tasks as it admits. */
  'ADMISSION_LIMIT',
  /** A task under the start's continuity key is running in the container. */
  'CONTINUITY_KEY_RUNNING',
] as const;
export const StartRefusalEnum = z.enum(START_REFUSALS);
export type StartRefusal = z.infer<typeof StartRefusalEnum>;

/** HTTP's meaning of each refusal, as the error's `reason`. */
export const START_REFUSAL_REASONS = [
  'SERVICE_UNAVAILABLE',
  'TOO_MANY_REQUESTS',
] as const;
export const StartRefusalReasonEnum = z.enum(START_REFUSAL_REASONS);
export type StartRefusalReason = z.infer<typeof StartRefusalReasonEnum>;

export const START_REFUSAL_REASON_BY_REFUSAL: Record<
  StartRefusal,
  StartRefusalReason
> = {
  CONTAINER_STOPPING: 'SERVICE_UNAVAILABLE',
  ADMISSION_LIMIT: 'TOO_MANY_REQUESTS',
  CONTINUITY_KEY_RUNNING: 'TOO_MANY_REQUESTS',
};

/** The `google.rpc.ErrorInfo` domain that marks an error as AgentForge's. */
export const AGENTFORGE_ERROR_DOMAIN = 'agentforge';
export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * The refusal as A2A 1.0 carries an error's identity: one `ErrorInfo` in the
 * JSON-RPC error's `data`. Its metadata is a string map, as `ErrorInfo`'s is.
 */
export const StartRefusalErrorInfoSchema = z.object({
  '@type': z.literal(ERROR_INFO_TYPE),
  reason: StartRefusalReasonEnum,
  domain: z.literal(AGENTFORGE_ERROR_DOMAIN),
  metadata: z.object({
    refusal: StartRefusalEnum,
    retryAfterSeconds: z
      .string()
      .regex(/^[1-9]\d*$/, 'a positive whole number of seconds'),
  }),
});
export type StartRefusalErrorInfo = z.infer<typeof StartRefusalErrorInfoSchema>;

export function startRefusalErrorInfo(
  refusal: StartRefusal,
  retryAfterSeconds: number,
): StartRefusalErrorInfo {
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error(
      `a refusal's retry is a positive whole number of seconds, not ${retryAfterSeconds}`,
    );
  }
  return {
    '@type': ERROR_INFO_TYPE,
    reason: START_REFUSAL_REASON_BY_REFUSAL[refusal],
    domain: AGENTFORGE_ERROR_DOMAIN,
    metadata: { refusal, retryAfterSeconds: String(retryAfterSeconds) },
  };
}

/**
 * The refusal a JSON-RPC error's `data` carries, or undefined when it carries
 * none. An `agentforge` ErrorInfo that does not parse is thrown, never read as
 * an ordinary error.
 */
export function startRefusalOf(
  data: unknown,
): { refusal: StartRefusal; retryAfterSeconds: number } | undefined {
  if (!Array.isArray(data)) return undefined;
  const info = data.find(
    (detail: unknown) =>
      typeof detail === 'object' &&
      detail !== null &&
      (detail as { domain?: unknown }).domain === AGENTFORGE_ERROR_DOMAIN,
  );
  if (info === undefined) return undefined;
  const parsed = StartRefusalErrorInfoSchema.parse(info);
  return {
    refusal: parsed.metadata.refusal,
    retryAfterSeconds: Number(parsed.metadata.retryAfterSeconds),
  };
}
