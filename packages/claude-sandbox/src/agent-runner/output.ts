import { END_SENTINEL, START_SENTINEL } from './constants.js';
import type { AgentForgeContainerOutput } from './types.js';

/**
 * Write sentinel-wrapped output to stdout.
 */
export function emitOutput(output: AgentForgeContainerOutput): void {
  process.stdout.write(`${START_SENTINEL}\n`);
  process.stdout.write(JSON.stringify(output));
  process.stdout.write(`\n${END_SENTINEL}\n`);
}

/**
 * Emit a success output with structured data.
 */
export function emitSuccess(data: {
  structuredOutput?: unknown;
  sessionId?: string;
  metrics?: AgentForgeContainerOutput['metrics'];
}): void {
  emitOutput({
    status: 'success',
    structuredOutput: data.structuredOutput,
    sessionId: data.sessionId,
    metrics: data.metrics,
  });
}

/**
 * Emit an error output.
 */
export function emitError(error: unknown): void {
  emitOutput({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}
