/**
 * What a test asks the fixture container to do, carried as the one data part
 * of a `SendMessage`. Shared by the container, which parses it, and the tests,
 * which build it, so the two cannot drift.
 *
 * No model is called: a "task" is a timer, so every number the AgentCore tests
 * assert is platform cost.
 */
import { z } from 'zod';

/** Where the container records an outcome from its SIGTERM handler (§C). */
export const OutcomeTargetSchema = z
  .object({
    tableName: z.string().min(1),
    /** The row's `outcomeKey`, the table's partition key. */
    key: z.string().min(1),
  })
  .strict();

export const FixtureEnvelopeSchema = z
  .object({
    /** How long the task runs. A timer, never a model call. */
    runMilliseconds: z.number().int().nonnegative(),
    outcomeTarget: OutcomeTargetSchema.optional(),
  })
  .strict();

export type OutcomeTarget = z.infer<typeof OutcomeTargetSchema>;
export type FixtureEnvelope = z.infer<typeof FixtureEnvelopeSchema>;

/**
 * What the container reports on the task it creates, as the task's metadata.
 * The task store keeps the metadata of the first `task` event, so `GetTask`
 * returns what the CREATING container reported, not the answering one.
 */
export const FixtureTaskMetadataSchema = z.object({
  /** Minted on the container's first invocation, so a second container is detectable (§B). */
  containerId: z.string(),
  /** Tasks live in this container at the moment it answered, this one included. */
  liveTasks: z.number(),
  /** The version the A2A SDK negotiated for the request that created the task. */
  negotiatedVersion: z.string(),
  /**
   * The container's clock when it answered, so a driver outside the microVM
   * can compute the offset NTP-style and put the container's timestamps in
   * its own frame.
   */
  containerNow: z.number(),
});

export type FixtureTaskMetadata = z.infer<typeof FixtureTaskMetadataSchema>;
