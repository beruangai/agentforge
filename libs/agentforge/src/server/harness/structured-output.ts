import {
  type JSONSchema,
  transformJSONSchema,
} from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z } from 'zod';

/** The property a non-object agent contract is nested under, when a run opts in. */
export const STRUCTURED_OUTPUT_WRAPPER_KEY = 'output';

export interface StructuredOutputWireSchema {
  /** The JSON Schema as sent, as `outputFormat.schema`. */
  readonly schema: JSONSchema;
  /** Whether the contract was nested under `STRUCTURED_OUTPUT_WRAPPER_KEY`. */
  readonly wrapped: boolean;
}

/**
 * The agent contract as the wire schema structured output needs.
 *
 * Structured output is a tool (`StructuredOutput`), and a tool's input schema
 * must be an object at its root — stricter than the Messages API's own output
 * format. A contract with any other root, a root-level union above all, is
 * refused: it usually asks too much of one answer, and the fix is a better
 * contract. `wrapNonObjectOutput` opts in to nesting it under one property
 * instead, unwrapped again before validation, so nothing else sees the extra
 * level.
 */
export function structuredOutputWireSchema(
  contract: z.ZodType,
  options: { readonly wrapNonObjectOutput: boolean },
): StructuredOutputWireSchema {
  const schema = structuredOutputJsonSchema(contract);
  if (schema.type === 'object') return { schema, wrapped: false };
  if (!options.wrapNonObjectOutput) {
    throw new Error(
      `the agent contract's root is ${describeRoot(schema)}; structured output is a tool, and a tool's input must be an object. ` +
        'Give the contract an object root — a root union or array usually means one answer is asked to do too much — ' +
        'or pass `wrapNonObjectOutput: true` to nest it under a property on the wire.',
    );
  }
  return {
    schema: {
      type: 'object',
      properties: { [STRUCTURED_OUTPUT_WRAPPER_KEY]: schema },
      required: [STRUCTURED_OUTPUT_WRAPPER_KEY],
      additionalProperties: false,
    },
    wrapped: true,
  };
}

/**
 * The declared value from a returned payload. A wrapped payload missing its
 * property passes through untouched, so validation names the real mismatch.
 */
export function unwrapStructuredOutput(
  value: unknown,
  wrapped: boolean,
): unknown {
  if (!wrapped || value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return STRUCTURED_OUTPUT_WRAPPER_KEY in record
    ? record[STRUCTURED_OUTPUT_WRAPPER_KEY]
    : value;
}

/**
 * A Zod schema as the JSON Schema structured output accepts, through the
 * Anthropic SDK's own `transformJSONSchema` (verified against 0.128.0,
 * 2026-09-25): it keeps only what the tool surface supports, forces
 * `additionalProperties: false`, keeps the `format`s it lists, and folds
 * every other keyword into the description as prose.
 *
 * The CLI validates a submission against this schema in the turn and has
 * the agent retry, which is what makes a kept constraint worth more than
 * prose: `type`, `required`, `enum` and `const` are enforced there. `format`
 * is not (2026-09-25) — it reaches the model as a hint, and only the contract's
 * own parse after the run catches a bad value.
 *
 * - **Zod's default target, not draft-07**: the transform walks `$defs`, and
 *   draft-07's `definitions` would be folded into prose, leaving every `$ref`
 *   dangling.
 * - **Inline reuse**: hoisted `$defs` for reused schemas include empty `{}`
 *   placeholders the transform throws on.
 * - **The input side** (`io: 'input'`): the model produces what the schema
 *   parses, not what it outputs.
 * - **`enum` and `const` kept**: the transform folds both into prose, which
 *   would turn every union's discriminator into a hint. They are stripped
 *   before it and put back after.
 */
export function structuredOutputJsonSchema(schema: z.ZodType): JSONSchema {
  const raw = z.toJSONSchema(schema, {
    io: 'input',
    reused: 'inline',
  }) as JSONSchema;
  delete raw.$schema;
  forEachNode(raw, refuseOpenKeys);
  const stripped = structuredClone(raw);
  forEachNode(stripped, (node) => {
    delete node.const;
    delete node.enum;
  });
  const transformed = transformJSONSchema(stripped);
  reattachConstraints(transformed, raw);
  return transformed;
}

/**
 * The transform closes every object (`additionalProperties: false`), so a
 * record — keys the contract does not name — could only ever come back empty.
 */
function refuseOpenKeys(node: JSONSchema): void {
  const additional = node.additionalProperties;
  if (
    node.propertyNames !== undefined ||
    (isSchema(additional) && Object.keys(additional).length > 0)
  ) {
    throw new Error(
      'the agent contract has a record (keys it does not name); structured output closes every object, so it would always come back empty. ' +
        'Use an array of { key, value } objects instead.',
    );
  }
}

const BRANCH_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

function forEachNode(
  node: JSONSchema,
  visit: (node: JSONSchema) => void,
): void {
  if (!isSchema(node)) return;
  visit(node);
  for (const child of Object.values(node.properties ?? {})) {
    forEachNode(child as JSONSchema, visit);
  }
  for (const child of Object.values(node.$defs ?? {})) {
    forEachNode(child as JSONSchema, visit);
  }
  if (isSchema(node.items)) forEachNode(node.items, visit);
  for (const keyword of BRANCH_KEYWORDS) {
    for (const branch of node[keyword] ?? []) forEachNode(branch, visit);
  }
}

/** Walks both trees together; the transform rewrites `oneOf` as `anyOf`. */
function reattachConstraints(transformed: JSONSchema, raw: JSONSchema): void {
  if (!isSchema(transformed) || !isSchema(raw)) return;
  if (Array.isArray(raw.enum)) transformed.enum = raw.enum;
  if (raw.const !== undefined) transformed.const = raw.const;
  for (const container of ['properties', '$defs'] as const) {
    for (const [key, child] of Object.entries(raw[container] ?? {})) {
      const counterpart = transformed[container]?.[key];
      if (counterpart !== undefined) {
        reattachConstraints(counterpart, child as JSONSchema);
      }
    }
  }
  if (isSchema(raw.items) && isSchema(transformed.items)) {
    reattachConstraints(transformed.items, raw.items);
  }
  for (const keyword of BRANCH_KEYWORDS) {
    const rawBranches = raw[keyword];
    const transformedBranches =
      transformed[keyword === 'oneOf' ? 'anyOf' : keyword];
    if (!Array.isArray(rawBranches) || !Array.isArray(transformedBranches)) {
      continue;
    }
    rawBranches.forEach((branch: JSONSchema, index: number) => {
      reattachConstraints(transformedBranches[index], branch);
    });
  }
}

function describeRoot(schema: JSONSchema): string {
  if (Array.isArray(schema.anyOf)) return 'a union (anyOf)';
  if (Array.isArray(schema.allOf)) return 'an intersection (allOf)';
  return `of type ${JSON.stringify(schema.type ?? schema.$ref ?? 'unknown')}`;
}

function isSchema(value: unknown): value is JSONSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
