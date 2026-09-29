import { isDeepStrictEqual } from 'node:util';
import type { TargetConfiguration, Tree } from '@nx/devkit';

/**
 * Every artifact a generator creates is maintained — kept by sync and by
 * regeneration to what the installed AgentForge renders from the project's
 * components — or scaffolded — written once, when absent, and never touched
 * again. A maintained artifact is a whole file, a set of keys in a file the
 * consumer also edits, or a target.
 */
export interface MaintainedFile {
  /** Workspace-relative. */
  readonly path: string;
  /** What the file holds when current, given what it holds now (undefined when absent). */
  render(current: string | undefined): string;
}

export interface ScaffoldedFile {
  /** Workspace-relative. */
  readonly path: string;
  readonly content: string;
}

export interface ProjectArtifacts {
  readonly files: readonly MaintainedFile[];
  /** The project's maintained targets, by name. */
  readonly targets: Readonly<Record<string, TargetConfiguration>>;
}

/** Heads every maintained file that can carry a comment. */
export function maintainedHeader(comment: '//' | '#'): string {
  return [
    `${comment} Maintained by @beruangai/agentforge: \`nx sync\` rewrites this file to what the`,
    `${comment} installed version generates. To own it, name it in the project's`,
    `${comment} project.json metadata.agentforge.detached.files.`,
  ].join('\n');
}

type Json = Record<string, unknown>;

/**
 * A JSON file whose maintained keys are set by `apply` and every other key is
 * kept. Rewritten only when its content changes, so formatting the consumer
 * or a formatter chose survives a sync that changes nothing.
 */
export function maintainedJson(
  path: string,
  apply: (current: Json) => Json,
): MaintainedFile {
  return {
    path,
    render(current) {
      const parsed = current === undefined ? {} : (JSON.parse(current) as Json);
      const rendered = apply(structuredClone(parsed));
      return current !== undefined && isDeepStrictEqual(parsed, rendered)
        ? current
        : `${JSON.stringify(rendered, null, 2)}\n`;
    },
  };
}

/** An `index.ts` that star-exports a module: the line is maintained, the rest of the file the consumer's. */
export function maintainedStarExport(
  path: string,
  specifier: string,
): MaintainedFile {
  const line = `export * from '${specifier}';`;
  return {
    path,
    render(current) {
      if (current?.split('\n').some((existing) => existing.trim() === line)) {
        return current;
      }
      const kept = (current ?? '').trimEnd();
      return `${kept === '' ? '' : `${kept}\n`}${line}\n`;
    },
  };
}

/** Sets `entries` in an object-valued key, keeping the key's other entries. */
export function withEntries(
  json: Json,
  key: string,
  entries: Readonly<Record<string, string>>,
): Json {
  return {
    ...json,
    [key]: { ...((json[key] ?? {}) as Record<string, string>), ...entries },
  };
}

/** Reads a tree file, or undefined when it is absent. */
export function readTreeFile(tree: Tree, path: string): string | undefined {
  return tree.read(path, 'utf8') ?? undefined;
}
