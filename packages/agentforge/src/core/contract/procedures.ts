import {
  type AnyProcedureContract,
  defineMeta,
  type RouterContract,
} from '@orpc/contract';
import { hash as ohash } from 'ohash';
import { z } from 'zod';

const [timeBudgetMeta, readTimeBudget] = defineMeta(
  'agentforge.timeBudgetSeconds',
  (incoming: number) => z.number().int().positive().parse(incoming),
);

/**
 * A procedure's time budget, declared with its contract and overridable per
 * call (§REQ202): `oc.meta(timeBudget(600)).input(…).output(…)`. A contract
 * without one runs under the agent's default.
 */
export const timeBudget = timeBudgetMeta;

/** The time budget a procedure's contract declares, if any. */
export function timeBudgetOf(
  contract: AnyProcedureContract,
): number | undefined {
  return readTimeBudget(contract);
}

export interface ProcedureEntry {
  /** Dotted path in the contract. */
  readonly path: string;
  readonly contract: AnyProcedureContract;
}

function isProcedureContract(value: unknown): value is AnyProcedureContract {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~orpc' in value &&
    typeof value['~orpc'] === 'object'
  );
}

/** Every procedure in a contract router, with its dotted path. */
export function listProcedures(
  router: RouterContract,
  prefix: readonly string[] = [],
): ProcedureEntry[] {
  if (isProcedureContract(router)) {
    return [{ path: prefix.join('.'), contract: router }];
  }
  return Object.entries(router).flatMap(([key, child]) =>
    listProcedures(child, [...prefix, key]),
  );
}

export function procedureAt(
  router: RouterContract,
  path: string,
): AnyProcedureContract | undefined {
  let node: unknown = router;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || isProcedureContract(node))
      return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return isProcedureContract(node) ? node : undefined;
}

function schemasOf(
  contract: AnyProcedureContract,
  which: 'inputSchemas' | 'outputSchemas',
): z.ZodType {
  const schemas = contract['~orpc'][which] ?? [];
  const [schema, ...rest] = schemas;
  if (
    schema === undefined ||
    rest.length > 0 ||
    !(schema instanceof z.ZodType)
  ) {
    throw new Error(
      `a procedure contract needs exactly one Zod ${which === 'inputSchemas' ? 'input' : 'output'} schema`,
    );
  }
  return schema;
}

export function inputSchemaOf(contract: AnyProcedureContract): z.ZodType {
  return schemasOf(contract, 'inputSchemas');
}

export function outputSchemaOf(contract: AnyProcedureContract): z.ZodType {
  return schemasOf(contract, 'outputSchemas');
}

/**
 * A procedure's contract hash: its input and output as JSON Schema, hashed.
 * A container refuses a task whose hash its own contract does not match
 * (§REQ104), so a caller built against a different shape fails before work.
 */
export function contractHash(contract: AnyProcedureContract): string {
  return ohash({
    input: z.toJSONSchema(inputSchemaOf(contract), { io: 'input' }),
    output: z.toJSONSchema(outputSchemaOf(contract), { io: 'output' }),
  });
}
