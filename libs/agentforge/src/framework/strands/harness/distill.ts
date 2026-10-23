import {
  DISTILL_MAX_TURNS,
  type DistillSpec,
  distillDocuments,
} from '../../../server/harness/distill.ts';
import type { ContextBlock } from '../../../server/harness/prompt.ts';
import type { TaskContext } from './types.ts';

export {
  DEFAULT_DISTILL_CAP_TOKENS,
  DISTILL_OVERAGE_ALLOWANCE,
  type DistillDocument,
  type DistillSpec,
} from '../../../server/harness/distill.ts';

/** The small model a distillation runs on unless the spec names one. */
export const DEFAULT_DISTILL_MODEL = 'claude-haiku-5-5';

/**
 * Documents as context for a run, within a token cap (§REQ209), distilled
 * when they exceed it by one utility run of the procedure's own — no tools, no
 * layers, Haiku by default. The utility run is an ordinary run: cancelled with the
 * task, recorded on it.
 */
export function distill(
  context: Pick<TaskContext, 'runAgent'>,
  spec: DistillSpec,
): Promise<readonly ContextBlock[]> {
  return distillDocuments(spec, async (run) => {
    const { output } = await context.runAgent({
      prompt: run.prompt,
      output: run.output,
      options: {
        model: run.model ?? DEFAULT_DISTILL_MODEL,
        systemPrompt: run.systemPrompt,
        layers: false,
        limits: { turns: DISTILL_MAX_TURNS },
      },
    });
    return output;
  });
}
