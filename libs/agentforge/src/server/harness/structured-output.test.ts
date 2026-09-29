import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  structuredOutputJsonSchema,
  structuredOutputWireSchema,
  unwrapStructuredOutput,
} from './structured-output.ts';

const Union = z.discriminatedUnion('type', [
  z.object({ type: z.literal('a'), value: z.string() }),
  z.object({ type: z.literal('b'), reason: z.string() }),
]);

describe('structuredOutputJsonSchema', () => {
  it('keeps enum and const as constraints, not prose', () => {
    const schema = structuredOutputJsonSchema(
      z.object({ kind: z.enum(['x', 'y']), tag: z.literal('fixed') }),
    );
    expect(schema.properties.kind).toEqual({
      type: 'string',
      enum: ['x', 'y'],
    });
    expect(schema.properties.tag).toEqual({ type: 'string', const: 'fixed' });
  });

  it('keeps each union branch discriminator, with oneOf sent as anyOf', () => {
    const schema = structuredOutputJsonSchema(z.object({ result: Union }));
    const branches = schema.properties.result.anyOf;
    expect(
      branches.map(
        (branch: { properties: { type: { const: string } } }) =>
          branch.properties.type.const,
      ),
    ).toEqual(['a', 'b']);
  });

  it('keeps a supported format, and drops $schema', () => {
    const schema = structuredOutputJsonSchema(z.object({ link: z.url() }));
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.link).toEqual({ type: 'string', format: 'uri' });
  });

  it('closes every object', () => {
    const schema = structuredOutputJsonSchema(
      z.object({ nested: z.object({ name: z.string() }) }),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.nested.additionalProperties).toBe(false);
  });

  it('inlines a reused schema rather than hoisting it', () => {
    const Name = z.object({ first: z.string() });
    const schema = structuredOutputJsonSchema(
      z.object({ author: Name, editor: Name }),
    );
    expect(schema.$defs).toBeUndefined();
    expect(schema.properties.editor.properties.first).toEqual({
      type: 'string',
    });
  });

  it('keeps a recursive schema resolvable through $defs', () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.enum(['leaf', 'branch']), children: z.array(Node) }),
    );
    const schema = structuredOutputJsonSchema(z.object({ root: Node }));
    const serialized = JSON.stringify(schema);
    for (const [, ref] of serialized.matchAll(
      /"\$ref":"#\/\$defs\/([^"]+)"/g,
    )) {
      expect(schema.$defs?.[ref as string]).toBeDefined();
    }
    const definitions = Object.values(schema.$defs ?? {}) as {
      properties?: { name?: { enum?: string[] } };
    }[];
    expect(
      definitions.some((definition) => definition.properties?.name?.enum),
    ).toBe(true);
  });

  it('refuses a record, which a closed object could only return empty', () => {
    expect(() =>
      structuredOutputJsonSchema(
        z.object({ scores: z.record(z.string(), z.number()) }),
      ),
    ).toThrow(/record/);
  });
});

describe('structuredOutputWireSchema', () => {
  it('sends an object root unchanged', () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    expect(
      structuredOutputWireSchema(schema, { wrapNonObjectOutput: false }),
    ).toEqual({ schema: structuredOutputJsonSchema(schema), wrapped: false });
  });

  it('refuses a non-object root unless the run opts in', () => {
    expect(() =>
      structuredOutputWireSchema(Union, { wrapNonObjectOutput: false }),
    ).toThrow(/wrapNonObjectOutput/);
    expect(() =>
      structuredOutputWireSchema(z.array(z.string()), {
        wrapNonObjectOutput: false,
      }),
    ).toThrow(/"array"/);
  });

  it('nests an opted-in non-object root under one property', () => {
    const { schema, wrapped } = structuredOutputWireSchema(Union, {
      wrapNonObjectOutput: true,
    });
    expect(wrapped).toBe(true);
    expect(schema).toMatchObject({
      type: 'object',
      required: ['output'],
      additionalProperties: false,
    });
    expect(schema.properties.output.anyOf).toHaveLength(2);
  });
});

describe('unwrapStructuredOutput', () => {
  it('returns the value untouched when nothing was wrapped', () => {
    const value = { output: 'x' };
    expect(unwrapStructuredOutput(value, false)).toBe(value);
  });

  it('recovers the declared value from a wrapped payload', () => {
    const inner = { type: 'a', value: 'x' };
    expect(unwrapStructuredOutput({ output: inner }, true)).toBe(inner);
  });

  it('passes a payload missing its property through, for validation to name the mismatch', () => {
    const value = { type: 'a' };
    expect(unwrapStructuredOutput(value, true)).toBe(value);
    expect(unwrapStructuredOutput(null, true)).toBeNull();
  });
});
