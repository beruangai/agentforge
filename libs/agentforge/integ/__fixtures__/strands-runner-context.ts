import type { RunnerContext } from '../../src/framework/strands/harness/runner.ts';

/** A `strands` run on the Anthropic API, with the operator's key from `.env.integ.local`; no layers, no storage. */
export function strandsRunnerContext(): RunnerContext {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      'ANTHROPIC_API_KEY is unset: the strands model slices need it in .env.integ.local',
    );
  }
  return { apiKey, layers: [] };
}

/** The small model the strands slices run on. */
export const STRANDS_INTEG_MODEL = 'claude-haiku-5-5';
