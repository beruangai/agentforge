import { oc } from '@orpc/contract';
import { z } from 'zod';

/**
 * What callers import. Each procedure is an oRPC contract; AgentForge derives
 * `SendMessage` and `GetTask` for it, and checks its hash in the container.
 */
export const helloAgent = {
  /** Summarises a text — and continues a session when given one to resume. */
  summarise: oc
    .input(
      z.object({
        text: z.string().min(1),
        resumeSessionId: z.string().optional(),
      }),
    )
    .output(
      z.object({
        summary: z.string(),
        /** Computed, never asked of the model (§REQ102). */
        words: z.number(),
        sessionId: z.string(),
      }),
    ),
  /** Runs a shell command for a while before answering: something to cancel. */
  sleepThenAnswer: oc
    .input(z.object({ seconds: z.number().int().positive().max(600) }))
    .output(z.object({ answer: z.string() })),
};
