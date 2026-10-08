import { oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refuseStrippingObjects } from './strict-objects.ts';

const procedure = (output: z.ZodType) =>
  oc.input(z.strictObject({})).output(output);

/** The refusal's lines naming stripping objects, in order. */
function refused(contract: Parameters<typeof refuseStrippingObjects>[0]) {
  try {
    refuseStrippingObjects(contract);
  } catch (error) {
    return (error as Error).message
      .split('\n')
      .filter((line) => line.endsWith('— z.object'))
      .map((line) => line.trim().replace(/ — z\.object$/, ''));
  }
  return [];
}

describe('a contract that would drop undeclared keys', () => {
  it('is refused at the root, naming the procedure, the side and the fix', () => {
    expect(() =>
      refuseStrippingObjects({
        Write: oc
          .input(z.object({ topic: z.string() }))
          .output(z.strictObject({})),
      }),
    ).toThrow(
      'procedure contract refused (§REQ103): these objects drop keys they do not name, silently:\n  Write.input — z.object\nUse z.strictObject to refuse undeclared keys, or z.looseObject to keep them.',
    );
  });

  it('is refused nested in an array, a union, an optional and a lazy schema, each by its path', () => {
    const stripping = z.object({ a: z.string() });
    expect(
      refused({
        Write: procedure(
          z.strictObject({
            cases: z.array(stripping),
            either: z.union([z.string(), stripping]),
            maybe: stripping.optional(),
            later: z.lazy(() => stripping),
          }),
        ),
      }),
    ).toEqual([
      'Write.output.cases[]',
      'Write.output.either<option 2>',
      'Write.output.maybe',
      'Write.output.later',
    ]);
  });

  it('names every place at once, across procedures and namespaces', () => {
    expect(
      refused({
        Write: oc.input(z.object({})).output(z.object({})),
        kata: { Grade: procedure(z.record(z.string(), z.object({}))) },
      }),
    ).toEqual(['Write.input', 'Write.output', 'kata.Grade.output{}']);
  });

  it('is refused where a strict object merged a stripping one, whose catchall it took', () => {
    expect(
      refused({
        Write: procedure(z.strictObject({ a: z.string() }).merge(z.object({}))),
      }),
    ).toEqual(['Write.output']);
  });

  it('walks a recursive schema to its end', () => {
    const Node: z.ZodType = z.strictObject({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
      loose: z.lazy(() => z.object({ next: Node })),
    });
    expect(refused({ Tree: procedure(Node) })).toEqual(['Tree.output.loose']);
  });
});

describe('a contract whose objects are explicit', () => {
  it('is accepted strict, loose, `.strict()` and extended', () => {
    const strict = z.strictObject({ a: z.string() });
    expect(() =>
      refuseStrippingObjects({
        Write: oc.input(z.object({ a: z.string() }).strict()).output(
          z.strictObject({
            strict,
            extended: strict.extend({ b: z.number() }),
            loose: z.looseObject({ c: z.string() }),
            typed: z.object({ d: z.string() }).catchall(z.number()),
            piped: z.string().transform((value) => value.length),
            tuple: z.tuple([z.string()], z.number()),
            intersection: z.intersection(strict, z.looseObject({})),
          }),
        ),
      }),
    ).not.toThrow();
  });
});

describe('a schema type the walk does not know', () => {
  it('is refused, naming it', () => {
    const unknownType = z.string();
    (unknownType._zod.def as { type: string }).type = 'novel';
    expect(() =>
      refuseStrippingObjects({
        Write: procedure(z.strictObject({ unknownType })),
      }),
    ).toThrow(
      'the strict-object check does not know these schema types, so cannot tell whether they hold such an object:\n  Write.output.unknownType — a Zod "novel" schema',
    );
  });
});
