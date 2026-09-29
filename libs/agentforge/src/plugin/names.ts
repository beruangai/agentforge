import { z } from 'zod';

/** A project or agent name: kebab-case, which every name derived from it stays valid as. */
export const KebabNameField = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    'must be kebab-case: lowercase letters and digits, words joined by single hyphens',
  );

/** A procedure's name, as the contract declares it (`PascalCase`). */
export const ProcedureNameField = z
  .string()
  .regex(
    /^[A-Z][A-Za-z0-9]*$/,
    'must be PascalCase: a capital letter, then letters and digits',
  );

/** `golden-kata` → `GoldenKata`. */
export function pascalCase(kebabName: string): string {
  return kebabName
    .split('-')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('');
}

/** `golden-kata` → `goldenKata`. */
export function camelCase(kebabName: string): string {
  const pascal = pascalCase(kebabName);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

/** `golden-kata` → `GOLDEN_KATA`. */
export function upperSnakeCase(kebabName: string): string {
  return kebabName.toUpperCase().replaceAll('-', '_');
}

/** A package name's scope without its `@`: `@beruangai/golden-kata` → `beruangai`. */
export function scopeOf(packageName: string): string {
  const scope = /^@([^/]+)\/[^/]+$/.exec(packageName)?.[1];
  if (scope === undefined) {
    throw new Error(
      `${packageName} is not a scoped package name (@<scope>/<name>)`,
    );
  }
  return scope;
}

/** Parses a name, throwing with what it names and why it is invalid. */
export function parseName(
  field: z.ZodString,
  what: string,
  value: string,
): string {
  const parsed = field.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${what} "${value}" ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}
