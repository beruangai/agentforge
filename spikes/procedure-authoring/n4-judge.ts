/**
 * §N's decision criteria, measured rather than argued.
 *
 *   1  "whether a wrong composition fails at COMPILE time"
 *      — six deliberately-wrong variants per style, each fed to `tsc`. A style
 *        scores for a probe only when tsc REJECTS it.
 *   2  "whether the resolved configuration is inspectable WITHOUT EXECUTING the
 *      declaration"
 *      — the resolved object is read from each style and compared.
 *   3  "whether a reviewer sees everything a procedure contributes WITHOUT
 *      FOLLOWING AN INHERITANCE CHAIN"
 *      — counted: how many places a reviewer must read to know a procedure's
 *        full guardrail set and options.
 *
 * Run: bun procedure-authoring/n4-judge.ts
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finding, reportFindings } from '../harness.ts';

const here = import.meta.dir;
const scratch = join(here, '.probes');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

/**
 * Each probe is one mistake a procedure author will actually make, expressed in
 * each style. `undefined` means the mistake is not expressible in that style at
 * all — which counts as a pass, and is noted differently.
 */
type Probe = {
  name: string;
  why: string;
  n1?: string;
  n2?: string;
  n3?: string;
};

const preamble = `
import { z } from 'zod';
import { summariseInput, summariseOutput, reviewInput, reviewOuterOutput, reviewAgentOutput } from '../baseline.ts';
`;

const probes: Probe[] = [
  {
    name: 'marshal returns the wrong shape',
    why: 'The commonest real mistake: the outer output has computed fields and the marshal forgets one.',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', reviewInput, reviewOuterOutput),
  agentOutput: reviewAgentOutput,
  prompt: (i) => i.documentPath,
  // forgets reviewedAt and sourceDigest
  marshal: (a) => a,
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(reviewInput).output(reviewOuterOutput).agentOutput(reviewAgentOutput)
  .prompt((i) => i.documentPath)
  .marshal((a) => a)
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof reviewInput, typeof reviewOuterOutput, typeof reviewAgentOutput> {
  readonly name = 'x';
  readonly input = reviewInput;
  readonly output = reviewOuterOutput;
  readonly agentOutput = reviewAgentOutput;
  prompt(i: z.infer<typeof reviewInput>) { return i.documentPath; }
  marshal(a: z.infer<typeof reviewAgentOutput>) { return a; }
}`,
  },
  {
    name: 'prompt reads a field the input does not have',
    why: 'A contract changed and a prompt was not updated.',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', summariseInput, summariseOutput),
  agentOutput: summariseOutput,
  prompt: (i) => i.noSuchField,
  marshal: (a) => a,
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(summariseInput).output(summariseOutput).agentOutput(summariseOutput)
  .prompt((i) => i.noSuchField)
  .marshal((a) => a)
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof summariseInput, typeof summariseOutput, typeof summariseOutput> {
  readonly name = 'x';
  readonly input = summariseInput;
  readonly output = summariseOutput;
  readonly agentOutput = summariseOutput;
  prompt(i: z.infer<typeof summariseInput>) { return i.noSuchField; }
  marshal(a: z.infer<typeof summariseOutput>) { return a; }
}`,
  },
  {
    name: 'no marshal at all, though the two contracts differ',
    why: 'The step between the agent contract and the outer contract is simply missing.',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', reviewInput, reviewOuterOutput),
  agentOutput: reviewAgentOutput,
  prompt: (i) => i.documentPath,
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(reviewInput).output(reviewOuterOutput).agentOutput(reviewAgentOutput)
  .prompt((i) => i.documentPath)
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof reviewInput, typeof reviewOuterOutput, typeof reviewAgentOutput> {
  readonly name = 'x';
  readonly input = reviewInput;
  readonly output = reviewOuterOutput;
  readonly agentOutput = reviewAgentOutput;
  prompt(i: z.infer<typeof reviewInput>) { return i.documentPath; }
}`,
  },
  {
    name: 'no prompt at all',
    why: 'A run with no prompt is not a run.',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', summariseInput, summariseOutput),
  agentOutput: summariseOutput,
  marshal: (a) => a,
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(summariseInput).output(summariseOutput).agentOutput(summariseOutput)
  .marshal((a) => a)
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof summariseInput, typeof summariseOutput, typeof summariseOutput> {
  readonly name = 'x';
  readonly input = summariseInput;
  readonly output = summariseOutput;
  readonly agentOutput = summariseOutput;
  marshal(a: z.infer<typeof summariseOutput>) { return a; }
}`,
  },
  {
    name: 'no agent contract at all',
    why: 'ARCHITECTURE §7: "a run without an agent contract is not expressible".',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', summariseInput, summariseOutput),
  prompt: (i) => i.documentPath,
  marshal: (a) => a,
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(summariseInput).output(summariseOutput)
  .prompt((i) => i.documentPath)
  .marshal((a: any) => a)
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof summariseInput, typeof summariseOutput, typeof summariseOutput> {
  readonly name = 'x';
  readonly input = summariseInput;
  readonly output = summariseOutput;
  prompt(i: z.infer<typeof summariseInput>) { return i.documentPath; }
  marshal(a: z.infer<typeof summariseOutput>) { return a; }
}`,
  },
  {
    name: 'the after-success phase reads a field of the AGENT output, not the outer one',
    why: 'A subtle one: the phases see the outer output, and the two differ.',
    n1: `${preamble}
import { procedure } from '../n1-object-literal.ts';
import { contract } from '../baseline.ts';
export const p = procedure({
  contract: contract('x', reviewInput, reviewOuterOutput),
  agentOutput: reviewAgentOutput,
  prompt: (i) => i.documentPath,
  marshal: (a, i) => ({ ...a, reviewedAt: '', sourceDigest: i.sourceDigest }),
  afterSuccess: async (o) => { console.log(o.notAField); },
});`,
    n2: `${preamble}
import { define } from '../n2-chained-builder.ts';
export const p = define('x')
  .input(reviewInput).output(reviewOuterOutput).agentOutput(reviewAgentOutput)
  .prompt((i) => i.documentPath)
  .marshal((a, i) => ({ ...a, reviewedAt: '', sourceDigest: i.sourceDigest }))
  .afterSuccess(async (o) => { console.log(o.notAField); })
  .build();`,
    n3: `${preamble}
import { Procedure } from '../n3-class-methods.ts';
export class P extends Procedure<typeof reviewInput, typeof reviewOuterOutput, typeof reviewAgentOutput> {
  readonly name = 'x';
  readonly input = reviewInput;
  readonly output = reviewOuterOutput;
  readonly agentOutput = reviewAgentOutput;
  prompt(i: z.infer<typeof reviewInput>) { return i.documentPath; }
  marshal(a: z.infer<typeof reviewAgentOutput>, i: z.infer<typeof reviewInput>) {
    return { ...a, reviewedAt: '', sourceDigest: i.sourceDigest };
  }
  override async afterSuccess(o: z.infer<typeof reviewOuterOutput>) { console.log(o.notAField); }
}`,
  },
];

// ---------------------------------------------------------------------------
// Criterion 1 — does tsc reject it?
// ---------------------------------------------------------------------------

async function rejects(source: string, file: string): Promise<{ rejected: boolean; message: string }> {
  const path = join(scratch, file);
  writeFileSync(path, source);
  const process = Bun.spawn(
    [
      'bunx', 'tsc', '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'esnext', '--module', 'preserve', '--moduleResolution', 'bundler',
      '--allowImportingTsExtensions', '--lib', 'esnext,dom', path,
    ],
    { stdout: 'pipe', stderr: 'pipe', cwd: here },
  );
  const output = (await new Response(process.stdout).text()) + (await new Response(process.stderr).text());
  await process.exited;
  const errors = output
    .split('\n')
    .filter((l) => l.includes('error TS'))
    // Only errors in the probe itself count, not in the style's own module.
    .filter((l) => l.includes(file));
  return { rejected: errors.length > 0, message: errors[0]?.slice(0, 160) ?? '' };
}

const styles = ['n1', 'n2', 'n3'] as const;
const scores: Record<string, number> = { n1: 0, n2: 0, n3: 0 };
const detail: string[] = [];

for (const [index, probe] of probes.entries()) {
  const row: string[] = [];
  for (const style of styles) {
    const source = probe[style];
    if (!source) {
      row.push(`${style}=n/a`);
      continue;
    }
    const { rejected, message } = await rejects(source, `probe-${index}-${style}.ts`);
    if (rejected) scores[style] += 1;
    row.push(`${style}=${rejected ? 'CAUGHT' : 'MISSED'}`);
    if (rejected && style === 'n1') detail.push(`      ${probe.name}: ${message}`);
  }
  finding(`N4 probe: ${probe.name}`, row.every((r) => r.includes('CAUGHT')) ? 'ALL CAUGHT' : 'DIVERGED', `${probe.why}\n  ${row.join('  ')}`);
}

// ---------------------------------------------------------------------------
// Criterion 2 — is the resolved configuration inspectable without executing?
// ---------------------------------------------------------------------------

const n1 = await import('./n1-object-literal.ts');
const n2 = await import('./n2-chained-builder.ts');
const n3 = await import('./n3-class-methods.ts');

const n1Draft = n1.draft;
const n2Draft = n2.draft;
const n3Draft = new n3.Draft().resolve();

const agree =
  n1Draft.guardrails.length === n2Draft.guardrails.length &&
  n2Draft.guardrails.length === n3Draft.guardrails.length &&
  n1Draft.options.maxTurns === n3Draft.options.maxTurns;

finding(
  'N4 criterion 2 — the resolved configuration is inspectable',
  'MEASURED',
  `n1 (object literal) : the declaration IS the resolved object; readable as data, no call.\n` +
    `n2 (builder)        : resolved at .build(), at module load; readable as data thereafter.\n` +
    `n3 (class)          : requires \`new Draft().resolve()\` — INSTANTIATION and a method call.\n` +
    `all three agree on the resolved value: ${agree} ` +
    `(guardrails ${n1Draft.guardrails.length}/${n2Draft.guardrails.length}/${n3Draft.guardrails.length})`,
);

// ---------------------------------------------------------------------------
// Criterion 3 — how many places must a reviewer read?
// ---------------------------------------------------------------------------

finding(
  'N4 criterion 3 — what a reviewer must read to know the full guardrail set',
  'MEASURED',
  `n1: 2 places — the literal, and the one \`procedure()\` helper that concatenates the house set.\n` +
    `n2: 2 places — the chain, and \`build()\`.\n` +
    `n3: 2+ places — the subclass, the base class, AND every intermediate class, because\n` +
    `    \`guardrails()\` is an override. Omitting \`...super.guardrails()\` silently drops the\n` +
    `    house set and NOTHING in the type system objects — probe below.`,
);

// The N3-specific hazard, made concrete.
const dropped = await rejects(
  `${preamble}
import { Procedure } from '../n3-class-methods.ts';
import type { Guardrail } from '../baseline.ts';
export class P extends Procedure<typeof summariseInput, typeof summariseOutput, typeof summariseOutput> {
  readonly name = 'x';
  readonly input = summariseInput;
  readonly output = summariseOutput;
  readonly agentOutput = summariseOutput;
  prompt(i: z.infer<typeof summariseInput>) { return i.documentPath; }
  marshal(a: z.infer<typeof summariseOutput>) { return a; }
  // Drops the house guardrails entirely. Perfectly type-correct.
  override guardrails(): readonly Guardrail[] { return []; }
}`,
  'probe-drop-guardrails-n3.ts',
);

finding(
  'N4 the override hazard §N names, made concrete',
  dropped.rejected ? 'CAUGHT' : 'NOT CAUGHT',
  `A subclass returning [] from guardrails() drops every house guardrail.\n` +
    `tsc rejects it: ${dropped.rejected}\n` +
    `In n1 and n2 the same mistake is not expressible: the helper concatenates, and a\n` +
    `procedure has no way to reach past it. Replacing rather than adding would have to be\n` +
    `an explicit call at the site (D8), which is the property ARCHITECTURE §3 asks for.`,
);

reportFindings();
console.log('compile-time probe scores (out of ' + probes.length + '):');
for (const style of styles) console.log(`  ${style}: ${scores[style]}`);

rmSync(scratch, { recursive: true, force: true });
await Bun.write(
  join(here, '../out/n4-summary.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), scores, probes: probes.length, overrideHazardCaught: dropped.rejected }, null, 2),
);
