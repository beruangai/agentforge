import type { RouterContract } from '@orpc/contract';
import type { z } from 'zod';
import { inputSchemaOf, listProcedures, outputSchemaOf } from './procedures.ts';

/** Schema types that hold no other schema, so no object. */
const LEAF_TYPES = new Set([
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'symbol',
  'undefined',
  'null',
  'void',
  'any',
  'unknown',
  'never',
  'nan',
  'literal',
  'enum',
  'template_literal',
  'file',
  'transform',
  'custom',
  'function',
]);

/** Schema types whose definition wraps one other schema as `innerType`. */
const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
  'success',
  'promise',
]);

/** What the walk reads of a schema: Zod 4's own definition, `schema._zod.def`. */
type Definition = { readonly type: string } & Readonly<Record<string, unknown>>;

function definitionOf(schema: z.ZodType): Definition {
  return schema._zod.def as unknown as Definition;
}

function schemaAt(definition: Definition, key: string): z.ZodType {
  return definition[key] as z.ZodType;
}

/**
 * Throws, naming each place, when any procedure's input or output holds an
 * object that strips undeclared keys (§REQ103): `z.object`, rather than
 * `z.strictObject` or `z.looseObject`, either of which is an explicit choice.
 * Every other schema is walked through to the objects it can hold; a schema
 * already being walked above a place, as a recursive one is, is not entered
 * again. A schema type the walk does not know throws, so none passes unwalked.
 */
export function refuseStrippingObjects(contract: RouterContract): void {
  const stripping: string[] = [];
  const unknown: string[] = [];

  /** The schemas a definition holds, each at its path; an object that strips is noted on the way. */
  function children(
    definition: Definition,
    path: string,
  ): ReadonlyArray<readonly [z.ZodType, string]> {
    const at = (key: string, place: string) =>
      [schemaAt(definition, key), place] as const;
    const { type } = definition;
    if (LEAF_TYPES.has(type)) return [];
    if (WRAPPER_TYPES.has(type)) return [at('innerType', path)];
    switch (type) {
      case 'object': {
        if (definition.catchall === undefined) stripping.push(path);
        const shape = definition.shape as Readonly<Record<string, z.ZodType>>;
        return [
          ...(definition.catchall === undefined
            ? []
            : [at('catchall', `${path}.*`)]),
          ...Object.entries(shape).map(
            ([key, value]) => [value, `${path}.${key}`] as const,
          ),
        ];
      }
      case 'array':
        return [at('element', `${path}[]`)];
      case 'set':
        return [at('valueType', `${path}[]`)];
      case 'tuple':
        return [
          ...(definition.items as readonly z.ZodType[]).map(
            (item, index) => [item, `${path}[${index}]`] as const,
          ),
          ...(definition.rest === null || definition.rest === undefined
            ? []
            : [at('rest', `${path}[…]`)]),
        ];
      case 'record':
      case 'map':
        return [at('keyType', `${path}{key}`), at('valueType', `${path}{}`)];
      case 'union':
        return (definition.options as readonly z.ZodType[]).map(
          (option, index) => [option, `${path}<option ${index + 1}>`] as const,
        );
      case 'intersection':
        return [at('left', path), at('right', path)];
      case 'pipe':
        return [at('in', path), at('out', path)];
      case 'lazy':
        return [[(definition.getter as () => z.ZodType)(), path]];
      default:
        unknown.push(`${path} — a Zod "${type}" schema`);
        return [];
    }
  }

  function walk(
    schema: z.ZodType,
    path: string,
    ancestors: ReadonlySet<z.ZodType>,
  ): void {
    if (ancestors.has(schema)) return;
    const within = new Set(ancestors).add(schema);
    for (const [child, place] of children(definitionOf(schema), path)) {
      walk(child, place, within);
    }
  }

  for (const { path, contract: procedure } of listProcedures(contract)) {
    walk(inputSchemaOf(procedure), `${path}.input`, new Set());
    walk(outputSchemaOf(procedure), `${path}.output`, new Set());
  }

  const reasons = [
    ...(stripping.length === 0
      ? []
      : [
          'these objects drop keys they do not name, silently:',
          ...stripping.map((path) => `  ${path} — z.object`),
          'Use z.strictObject to refuse undeclared keys, or z.looseObject to keep them.',
        ]),
    ...(unknown.length === 0
      ? []
      : [
          'the strict-object check does not know these schema types, so cannot tell whether they hold such an object:',
          ...unknown.map((place) => `  ${place}`),
        ]),
  ];
  if (reasons.length > 0) {
    throw new Error(
      `procedure contract refused (§REQ103): ${reasons.join('\n')}`,
    );
  }
}
