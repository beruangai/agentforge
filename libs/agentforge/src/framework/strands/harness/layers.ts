import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cause } from '#core/contract/task.ts';
import {
  describeError,
  TaskFailure,
} from '../../../server/harness/task-failure.ts';

/** The instruction file a layer carries at its root, as Strands' own harness names it. */
export const INSTRUCTION_FILE = 'AGENTS.md';
/** The directory of a layer's skills, each an agentskills.io `SKILL.md` directory. */
export const SKILLS_DIRECTORY = '.agent/skills';

export interface LayerConfiguration {
  /** Each layer's instructions that it carries, base first. */
  readonly instructions: readonly string[];
  /** Each layer's skills directory that exists, base first. */
  readonly skillDirectories: readonly string[];
}

/**
 * What the layers give a run, in the order they compose: base, then agent. A
 * layer may carry neither file; an instruction file that exists but cannot
 * be read fails the run before it starts.
 */
export async function readLayers(
  layers: readonly string[],
): Promise<LayerConfiguration> {
  const read = await Promise.all(
    layers.map(async (layer) => ({
      instructions: await readInstructions(path.join(layer, INSTRUCTION_FILE)),
      skills: (await exists(path.join(layer, SKILLS_DIRECTORY)))
        ? path.join(layer, SKILLS_DIRECTORY)
        : undefined,
    })),
  );
  return {
    instructions: read.flatMap(({ instructions }) =>
      instructions === undefined ? [] : [instructions],
    ),
    skillDirectories: read.flatMap(({ skills }) =>
      skills === undefined ? [] : [skills],
    ),
  };
}

async function readInstructions(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new TaskFailure(
      cause(
        'EXECUTION_ERROR',
        `the layer's instruction file "${file}" could not be read: ${describeError(error)}`,
      ),
    );
  }
}

async function exists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}
