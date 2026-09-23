/**
 * Every line the fixture container writes to stdout is one of these, as JSON.
 * AgentCore ships stdout to CloudWatch Logs, which is how a test observes what
 * happened inside a microVM it cannot reach — which headers arrived, when
 * SIGTERM landed, how long the process outlived it, what a lease write cost.
 *
 * Shared by the container, which writes them, and the log reader, which
 * validates them, so the two cannot drift.
 */
import { z } from 'zod';

const listeningEventSchema = z.object({
  event: z.literal('listening'),
  containerId: z.string(),
  port: z.number(),
  strict10: z.boolean(),
  at: z.number(),
});

/** Every request except `/ping`, for the pass-through questions (§I). */
const requestEventSchema = z.object({
  event: z.literal('request'),
  containerId: z.string(),
  method: z.string(),
  path: z.string(),
  contentType: z.string().nullable(),
  a2aVersion: z.string().nullable(),
  runtimeSessionId: z.string().nullable(),
  headerNames: z.array(z.string()),
  jsonRpcMethod: z.string().nullable(),
});

/** One lease generation written, and read back, from inside the microVM (§A). */
const leaseEventSchema = z.object({
  event: z.literal('lease'),
  containerId: z.string(),
  leaseId: z.string(),
  taskId: z.string(),
  generation: z.number(),
  writeLatencyMilliseconds: z.number(),
  /** `null` when the generation was not visible within ten seconds. */
  visibleAfterMilliseconds: z.number().nullable(),
  readBackPolls: z.number(),
  writeIssuedAt: z.number(),
});

const leaseFailedEventSchema = z.object({
  event: z.literal('lease-failed'),
  containerId: z.string(),
  leaseId: z.string(),
  generation: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
});

const sigtermEventSchema = z.object({
  event: z.literal('sigterm'),
  containerId: z.string(),
  at: z.number(),
  liveTasks: z.number(),
});

/** The outcome row written from inside the SIGTERM handler (§C). */
const shutdownOutcomeEventSchema = z.object({
  event: z.literal('shutdown-outcome'),
  containerId: z.string(),
  written: z.boolean(),
  tookMilliseconds: z.number(),
  afterSigtermMilliseconds: z.number(),
  errorName: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

/** A heartbeat every 500 ms after SIGTERM; the last one is when the process died. */
const postSigtermEventSchema = z.object({
  event: z.literal('post-sigterm'),
  containerId: z.string(),
  millisecondsSinceSigterm: z.number(),
  liveTasks: z.number(),
});

export const containerLogEventSchema = z.discriminatedUnion('event', [
  listeningEventSchema,
  requestEventSchema,
  leaseEventSchema,
  leaseFailedEventSchema,
  sigtermEventSchema,
  shutdownOutcomeEventSchema,
  postSigtermEventSchema,
]);

export type ContainerLogEvent = z.infer<typeof containerLogEventSchema>;
export type ContainerLogEventName = ContainerLogEvent['event'];
export type ContainerLogEventNamed<Name extends ContainerLogEventName> =
  Extract<ContainerLogEvent, { event: Name }>;
