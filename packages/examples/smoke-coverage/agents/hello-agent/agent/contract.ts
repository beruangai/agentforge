import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** A topic names the notebook's prefix its note is kept under. */
export const TopicField = z.string().regex(/^[a-z0-9-]{1,64}$/);

/**
 * What callers import to call the hello-agent agent: one procedure per
 * behaviour the smoke suites exercise.
 */
export const contract = {
  /** Summarises a text — and continues a session when given one to resume. */
  Summarise: oc
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
  /** Runs a shell command for a while before answering: something to cancel, or to lose. */
  SleepThenAnswer: oc
    .meta(timeBudget(300))
    .input(z.object({ seconds: z.number().int().positive().max(600) }))
    .output(z.object({ answer: z.string() })),
  /** Keeps a note in the notebook, an S3 filesystem, under a topic. */
  KeepNote: oc
    .input(z.object({ topic: TopicField, note: z.string().min(1) }))
    .output(
      z.object({
        /** Whether the file holds the note: read back, never asked of the model. */
        kept: z.boolean(),
      }),
    ),
  /** Reads back the note kept under a topic, whichever container kept it. */
  RecallNote: oc
    .input(z.object({ topic: TopicField }))
    .output(z.object({ note: z.string() })),
};
