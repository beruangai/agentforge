import { z } from 'zod';

/**
 * What a caller sends to start a task, as the one data part of an A2A
 * message. The runtime session id is not here: it is the transport's, and
 * reaches the container as AgentCore's session header.
 */
export const envelopeSchema = z.object({
  /** The procedure's path in the contract, dotted: `reviewStrategy` or `research.summarise`. */
  procedure: z.string().min(1),
  /** The hash of the contract the caller compiled against (§REQ104). */
  contractHash: z.string().min(1),
  input: z.unknown(),
  /** Names one logical execution across its attempts (§REQ305). */
  idempotencyKey: z.string().min(1),
  /** At most one live task per continuity key in a container — typically a Claude session id. */
  continuityKey: z.string().min(1).optional(),
  /** Overrides the procedure's time budget for this invocation (§REQ202). */
  timeBudgetSeconds: z.number().positive().optional(),
  /** Free-form, recorded, never load-bearing. */
  metadata: z.record(z.string(), z.string()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** The header AgentCore routes a session by; the local transport sends it too. */
export const runtimeSessionHeader =
  'x-amzn-bedrock-agentcore-runtime-session-id';
