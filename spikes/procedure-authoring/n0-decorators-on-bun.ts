/**
 * DESIGN_OPTIONS §N, "Check first":
 *   "whether standard TypeScript 5 decorators on Bun preserve inference through
 *    the decorated member, and whether decorator metadata needs a
 *    `Symbol.metadata` polyfill. If clean, decorator registration is available
 *    to N2 and N3; if not, it is out on toolchain grounds rather than taste."
 *
 * Standard decorators (the TC39 stage-3 ones TypeScript 5 implements), NOT the
 * `experimentalDecorators` legacy ones — those are the thing AgentForge's "no
 * legacy support" convention rules out anyway.
 *
 * Run: bun procedure-authoring/n0-decorators-on-bun.ts
 */
import { z } from 'zod';
import { finding, reportFindings } from '../harness.ts';

const results: Record<string, unknown> = {};

// --- 1: does a class-method decorator run at all on Bun? -------------------

const calls: string[] = [];

function records(label: string) {
  return function <This, Args extends any[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ) {
    calls.push(`${label}:${String(context.name)}`);
    return function (this: This, ...args: Args): Return {
      calls.push(`invoked:${String(context.name)}`);
      return target.call(this, ...args);
    };
  };
}

class Decorated {
  @records('method')
  step(input: { lane: string }): { lane: string; length: number } {
    return { lane: input.lane, length: input.lane.length };
  }
}

const instance = new Decorated();
const returned = instance.step({ lane: 'momentum' });

// If inference survived, `returned` is `{ lane: string; length: number }` and
// this compiles. If the decorator widened it to `any`, the assignment below
// still compiles — so the real test is `tsc --noEmit`, run separately.
const inferenceHolds: number = returned.length;

finding(
  'N0 a standard TypeScript 5 method decorator runs on Bun',
  calls.length >= 2 ? 'CONFIRMED' : 'FAILED',
  `decorator applications and invocations recorded: ${JSON.stringify(calls)}\n` +
    `returned value = ${JSON.stringify(returned)}, .length read as ${inferenceHolds}`,
);
results.methodDecorator = { calls, returned };

// --- 2: Symbol.metadata ----------------------------------------------------

const hasSymbolMetadata = typeof (Symbol as any).metadata !== 'undefined';

let metadataReadBack: unknown;
let metadataError: string | undefined;
try {
  function contract(schema: z.ZodTypeAny) {
    return function (target: any, context: ClassMethodDecoratorContext) {
      // The stage-3 metadata channel: what a registration decorator would use.
      (context.metadata as any).procedures ??= {};
      (context.metadata as any).procedures[String(context.name)] = schema;
      return target;
    };
  }

  class WithMetadata {
    @contract(z.object({ lane: z.string() }))
    run() {
      return 1;
    }
  }

  metadataReadBack = (WithMetadata as any)[(Symbol as any).metadata]?.procedures;
} catch (error) {
  metadataError = String(error);
}

finding(
  'N0 decorator metadata (Symbol.metadata) on Bun',
  metadataError ? 'FAILED' : metadataReadBack ? 'CONFIRMED' : 'UNAVAILABLE',
  `Symbol.metadata defined = ${hasSymbolMetadata}\n` +
    `context.metadata usable = ${!metadataError}\n` +
    `read back from the class = ${metadataReadBack ? Object.keys(metadataReadBack as any).join(', ') : 'nothing'}\n` +
    (metadataError ? `error: ${metadataError.slice(0, 300)}\n` : '') +
    'A polyfill is `Symbol.metadata ??= Symbol("Symbol.metadata")` — one line, but it must be loaded before any decorated module.',
);
results.symbolMetadata = { hasSymbolMetadata, readBack: Boolean(metadataReadBack), error: metadataError };

// --- 3: a class-level decorator that registers, the N3 shape ---------------

const registry = new Map<string, unknown>();

function procedure(name: string) {
  return function <T extends new (...args: any[]) => any>(target: T, context: ClassDecoratorContext): T {
    registry.set(name, target);
    return target;
  };
}

@procedure('analyse-lane')
class AnalyseLane {
  readonly input = z.object({ lane: z.string() });
}

finding(
  'N0 a class decorator can register a procedure at module load',
  registry.has('analyse-lane') ? 'CONFIRMED' : 'FAILED',
  `registry = [${[...registry.keys()].join(', ')}]\n` +
    'Registration at module load is what a decorator buys over an explicit `register()` call. ' +
    'The cost is that the registry is only populated for modules something imported — which a ' +
    'build-time card generator has to account for.',
);
results.classDecorator = { registered: [...registry.keys()] };

reportFindings();
console.log(
  '\nInference through the decorated member is NOT provable at runtime — run `bunx tsc --noEmit` ' +
    'on this file, which is the actual check.',
);
await Bun.write(
  `${import.meta.dir}/../out/n0-summary.json`,
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);
