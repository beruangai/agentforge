// Beside the layer rather than in it: the image copies base/agentic/ only.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kata } from './agentic/kata.ts';
import { runCases } from './agentic/run-cases.ts';

const KATA: Kata = {
  title: 'Sum',
  description: 'Return the sum of the numbers.',
  functionName: 'sum',
  signature: '(values: number[]) => number',
  cases: [
    { arguments: '[[]]', expected: '0' },
    { arguments: '[[1, 2, 3]]', expected: '6' },
    { arguments: '[[-1, 1]]', expected: '0' },
  ],
};

let directory: string;

async function write(kata: Kata, solution: string): Promise<void> {
  await writeFile(join(directory, 'kata.json'), JSON.stringify(kata));
  await writeFile(join(directory, 'solution.ts'), solution);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'run-cases-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('runCases', () => {
  it('passes every case a correct solution returns', async () => {
    await write(
      KATA,
      'export function sum(values: number[]): number { return values.reduce((a, b) => a + b, 0); }\n',
    );
    const results = await runCases(directory);
    expect(results).toMatchObject({ passed: 3, total: 3 });
    expect(results.cases.every((result) => result.passed)).toBe(true);
  });

  it('fails a case whose result differs, saying what it returned', async () => {
    await write(
      KATA,
      'export async function sum(values: number[]): Promise<number> { return values.length; }\n',
    );
    const results = await runCases(directory);
    expect(results.passed).toBe(1);
    expect(results.cases[1]).toEqual({
      passed: false,
      detail: 'returned 3, expected 6',
    });
  });

  it('fails a case whose JSON does not parse, and runs the others', async () => {
    await write(
      {
        ...KATA,
        cases: [
          ...KATA.cases.slice(0, 2),
          { arguments: '[[1, 2', expected: '3' },
        ],
      },
      'export function sum(values: number[]): number { return values.reduce((a, b) => a + b, 0); }\n',
    );
    const results = await runCases(directory);
    expect(results.passed).toBe(2);
    expect(results.cases[2]?.passed).toBe(false);
    expect(results.cases[2]?.detail).toMatch(/^the arguments is not JSON/);
  });

  it('fails a case the solution throws on', async () => {
    await write(
      KATA,
      "export function sum(values: number[]): number { if (values.length === 0) throw new Error('empty'); return values.reduce((a, b) => a + b); }\n",
    );
    const results = await runCases(directory);
    expect(results.passed).toBe(2);
    expect(results.cases[0]).toEqual({ passed: false, detail: 'threw: empty' });
  });

  it('fails a case that runs out of time', async () => {
    await write(
      KATA,
      'export function sum(values: number[]): number { if (values.length === 0) { while (true) {} } return values.reduce((a, b) => a + b); }\n',
    );
    const results = await runCases(directory, 1_000);
    expect(results.passed).toBe(2);
    expect(results.cases[0]).toEqual({
      passed: false,
      detail: 'timed out after 1000 ms',
    });
  });

  it('throws when kata.json is not a kata', async () => {
    await writeFile(join(directory, 'kata.json'), '{"title": "Sum"}');
    await expect(runCases(directory)).rejects.toThrow();
  });
});
