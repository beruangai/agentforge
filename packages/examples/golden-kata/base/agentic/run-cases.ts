import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import {
  type CaseResults,
  KATA_FILE,
  type Kata,
  KataSchema,
  SOLUTION_FILE,
} from './kata.ts';

const run = promisify(execFile);

const CASE_RUNNER = fileURLToPath(new URL('./case-runner.ts', import.meta.url));

/** How long one case may run before it counts as failed. */
export const CASE_TIMEOUT_MILLISECONDS = 5_000;

const CaseOutcomeSchema = z.union([
  z.object({ returned: z.string() }),
  z.object({ threw: z.string() }),
]);

type CaseResult = CaseResults['cases'][number];

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not JSON: ${(error as Error).message}`);
  }
}

/** The runner's report, its last line; undefined when the solution cut it off. */
function lastLineAsJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return undefined;
  }
}

async function runCase(
  solutionPath: string,
  kata: Kata,
  kataCase: Kata['cases'][number],
  timeoutMilliseconds: number,
): Promise<CaseResult> {
  let expected: unknown;
  try {
    const argumentsValue = parseJson(kataCase.arguments, 'the arguments');
    if (!Array.isArray(argumentsValue)) {
      return { passed: false, detail: 'the arguments are not a JSON array' };
    }
    expected = parseJson(kataCase.expected, 'the expected result');
  } catch (error) {
    return { passed: false, detail: (error as Error).message };
  }
  let stdout: string;
  try {
    ({ stdout } = await run(
      'bun',
      [CASE_RUNNER, solutionPath, kata.functionName, kataCase.arguments],
      { timeout: timeoutMilliseconds, killSignal: 'SIGKILL' },
    ));
  } catch (error) {
    const failed = error as { killed?: boolean; stderr?: string };
    return {
      passed: false,
      detail: failed.killed
        ? `timed out after ${timeoutMilliseconds} ms`
        : `the case runner failed: ${failed.stderr?.trim() || String(error)}`,
    };
  }
  const outcome = CaseOutcomeSchema.safeParse(lastLineAsJson(stdout));
  if (!outcome.success) {
    return {
      passed: false,
      detail: 'the solution ended the process before its case reported',
    };
  }
  if ('threw' in outcome.data) {
    return { passed: false, detail: `threw: ${outcome.data.threw}` };
  }
  const returned = outcome.data.returned;
  const passed = isDeepStrictEqual(JSON.parse(returned), expected);
  return {
    passed,
    detail: passed
      ? `returned ${returned}`
      : `returned ${returned}, expected ${kataCase.expected}`,
  };
}

/**
 * Runs the kata in `directory`'s `kata.json` against its `solution.ts`, each
 * case in its own `bun` process with a timeout, comparing what it returns
 * with the expected result by deep equality. A case whose JSON does not
 * parse, that throws, or that runs out of time fails; a `kata.json` that is
 * not a kata throws.
 */
export async function runCases(
  directory: string,
  timeoutMilliseconds = CASE_TIMEOUT_MILLISECONDS,
): Promise<CaseResults> {
  const kata = KataSchema.parse(
    parseJson(
      await readFile(join(directory, KATA_FILE), 'utf8'),
      `${directory}/${KATA_FILE}`,
    ),
  );
  const solutionPath = join(directory, SOLUTION_FILE);
  const cases = await Promise.all(
    kata.cases.map((kataCase) =>
      runCase(solutionPath, kata, kataCase, timeoutMilliseconds),
    ),
  );
  return {
    passed: cases.filter((result) => result.passed).length,
    total: cases.length,
    cases,
  };
}
