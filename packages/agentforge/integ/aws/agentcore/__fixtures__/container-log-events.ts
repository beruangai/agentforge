/**
 * Every line the fixture container writes to stdout is one of these, as JSON.
 * AgentCore ships stdout to CloudWatch Logs, which is how a test observes what
 * happened inside a microVM it cannot reach — which version header arrived,
 * when SIGTERM landed, how long the process outlived it, whether an outcome
 * could be written after it.
 *
 * Shared by the container, which writes them, and the log reader, which
 * validates them, so the two cannot drift.
 */
import { z } from 'zod';

/** Every invocation — a POST — so what reached the container is observed (ADR 0014). */
const RequestEventSchema = z.object({
  event: z.literal('request'),
  containerId: z.string(),
  a2aVersion: z.string().nullable(),
  runtimeSessionId: z.string().nullable(),
  jsonRpcMethod: z.string().nullable(),
});

const SigtermEventSchema = z.object({
  event: z.literal('sigterm'),
  containerId: z.string(),
  at: z.number(),
  liveTasks: z.number(),
});

/** The outcome row written from inside the SIGTERM handler (research §C). */
const ShutdownOutcomeEventSchema = z.object({
  event: z.literal('shutdown-outcome'),
  containerId: z.string(),
  written: z.boolean(),
  tookMilliseconds: z.number(),
  errorName: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

/** A heartbeat every 500 ms after SIGTERM; the last one is when the process died. */
const PostSigtermEventSchema = z.object({
  event: z.literal('post-sigterm'),
  containerId: z.string(),
  millisecondsSinceSigterm: z.number(),
  liveTasks: z.number(),
});

export const ContainerLogEventSchema = z.discriminatedUnion('event', [
  RequestEventSchema,
  SigtermEventSchema,
  ShutdownOutcomeEventSchema,
  PostSigtermEventSchema,
]);

export type ContainerLogEvent = z.infer<typeof ContainerLogEventSchema>;
export type ContainerLogEventName = ContainerLogEvent['event'];
export type ContainerLogEventNamed<Name extends ContainerLogEventName> =
  Extract<ContainerLogEvent, { event: Name }>;
