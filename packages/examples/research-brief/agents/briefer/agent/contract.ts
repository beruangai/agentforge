import { oc } from '@orpc/contract';
import { z } from 'zod';

/** A corpus names the documents bucket's prefix its documents are kept under. */
export const CorpusField = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** A glossary names the memory space the briefer keeps its terms in across tasks. */
export const GlossaryField = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** A passage of a document, quoted to support a claim. */
export const CitationSchema = z.strictObject({
  /** The document's path within the corpus. */
  document: z.string(),
  /** Words taken verbatim from the document. */
  quote: z.string(),
});

export const ClaimSchema = z.strictObject({
  statement: z.string(),
  citations: z.array(CitationSchema).min(1),
});

/** What callers import to call the briefer agent. */
export const contract = {
  /**
   * A brief answering a question from one corpus of documents: every claim
   * cites the documents it rests on, in their own words. Terms the corpus
   * defines are kept in a glossary that later briefs recall.
   */
  Brief: oc
    .input(
      z.strictObject({
        corpus: CorpusField,
        question: z.string().min(1),
        glossary: GlossaryField,
      }),
    )
    .output(
      z.strictObject({
        summary: z.string(),
        claims: z.array(ClaimSchema).min(1),
        /** How many documents the corpus held: counted, never asked of the model. */
        documents: z.number().int(),
      }),
    ),
};
