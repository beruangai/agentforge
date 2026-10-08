import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** A topic names the notebook's prefix its note is kept under. */
export const TopicField = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** A space names the memory an agent keeps across tasks, a prefix of the memories bucket. */
export const SpaceField = z.string().regex(/^[a-z0-9-]{1,64}$/);

/**
 * What callers import to call the hello-agent agent: one procedure per
 * behaviour the smoke suites exercise.
 */
export const contract = {
  /** Summarises a text — and continues a session when given one to resume. */
  Summarise: oc
    .input(
      z.strictObject({
        text: z.string().min(1),
        resumeSessionId: z.string().optional(),
      }),
    )
    .output(
      z.strictObject({
        summary: z.string(),
        /** Computed, never asked of the model (§REQ102). */
        words: z.number(),
        sessionId: z.string(),
      }),
    ),
  /** Answers a question from documents, distilled first when they exceed the cap: two runs, or one. */
  DistillThenAnswer: oc
    .input(
      z.strictObject({
        documents: z
          .array(
            z.strictObject({
              source: z.string().min(1),
              content: z.string().min(1),
            }),
          )
          .min(1),
        question: z.string().min(1),
        capTokens: z.number().int().positive(),
      }),
    )
    .output(
      z.strictObject({
        answer: z.string(),
        /** Whether the documents were distilled: read from the context, never asked of the model. */
        distilled: z.boolean(),
      }),
    ),
  /** Runs a shell command for a while before answering: something to cancel, or to lose. */
  SleepThenAnswer: oc
    .meta(timeBudget(300))
    .input(z.strictObject({ seconds: z.number().int().positive().max(600) }))
    .output(z.strictObject({ answer: z.string() })),
  /** Keeps a note in the notebook, an S3 filesystem, under a topic. */
  KeepNote: oc
    .input(z.strictObject({ topic: TopicField, note: z.string().min(1) }))
    .output(
      z.strictObject({
        /** Whether the file holds the note: read back, never asked of the model. */
        kept: z.boolean(),
      }),
    ),
  /** Reads back the note kept under a topic, whichever container kept it. */
  RecallNote: oc
    .input(z.strictObject({ topic: TopicField }))
    .output(z.strictObject({ note: z.string() })),
  /** Saves a fact to the agent's auto memory in a space. */
  Remember: oc
    .input(z.strictObject({ space: SpaceField, fact: z.string().min(1) }))
    .output(
      z.strictObject({
        /** Whether the space's `MEMORY.md` indexes a memory: read back, never asked of the model. */
        saved: z.boolean(),
      }),
    ),
  /** Answers a question from the agent's memory in a space, with no tools, whichever container saved it. */
  Recall: oc
    .input(z.strictObject({ space: SpaceField, question: z.string().min(1) }))
    .output(z.strictObject({ answer: z.string() })),
  /** Runs Python importing NautilusTrader, which the base layer installs, and answers with its version. */
  ReportNautilusTraderVersion: oc
    .input(z.strictObject({}))
    .output(z.strictObject({ version: z.string() })),
};
