import { join } from 'node:path';
import { readJson, type Tree, updateJson } from '@nx/devkit';
import { createJiti } from 'jiti';
import { minVersion, satisfies, validRange } from 'semver';
import { agentforgeManifest } from './container/container-inputs.ts';
import { CONTAINER_ROOT_DEPENDENCIES } from './container/container-workspace.ts';

/**
 * What an agentic project's generated code imports, beside AgentForge: the
 * container's runtime peers (its agents' code), the client's transports'
 * peers (its project client), and the constructs' peers (its constructs).
 */
export const AGENTIC_PROJECT_DEPENDENCIES = [
  ...CONTAINER_ROOT_DEPENDENCIES,
  '@aws-sdk/client-bedrock-agentcore',
  '@aws-sdk/client-appconfigdata',
  'aws-cdk-lib',
  'constructs',
] as const;

const AGENTFORGE = '@beruangai/agentforge';
const AWS_NX_PLUGIN_CONFIG = 'aws-nx-plugin.config.mts';

/** AgentForge's own range for one of its peers. */
export function peerRange(name: string): string {
  const range = agentforgeManifest().peerDependencies[name];
  if (range === undefined) {
    throw new Error(`${name} is not a peer of ${AGENTFORGE}`);
  }
  return range;
}

/**
 * `aws-nx-plugin.config.mts`'s default export, evaluated from the tree as
 * `@aws/nx-plugin` evaluates it — with jiti, which drops an import used only
 * as a type, as the preset's own `import { AwsNxPluginConfig }` is, and
 * resolves any other import from the workspace. `@aws/nx-plugin` does not
 * export its own reader. The on-disk cache is off, as there: it is keyed by
 * path, and a tree's content at one path changes as generators run.
 */
async function awsNxPluginConfig(
  tree: Tree,
): Promise<{ packageManager?: { catalogs?: boolean } } | undefined> {
  const source = tree.read(AWS_NX_PLUGIN_CONFIG, 'utf8');
  if (source === null) return undefined;
  const jiti = createJiti(import.meta.filename, { fsCache: false });
  let module: { default?: unknown };
  try {
    module = jiti.evalModule(source, {
      filename: join(tree.root, AWS_NX_PLUGIN_CONFIG),
    }) as { default?: unknown };
  } catch (error) {
    throw new Error(`${AWS_NX_PLUGIN_CONFIG} cannot be read`, {
      cause: error,
    });
  }
  return (module.default ?? module) as {
    packageManager?: { catalogs?: boolean };
  };
}

/**
 * Whether the workspace keeps versions in a catalog, as `@aws/nx-plugin`
 * decides it: a package manager with catalogs, unless its config turns them
 * off. AgentForge writes Bun's catalog, the root manifest's `catalog`.
 */
export async function catalogsEnabled(tree: Tree): Promise<boolean> {
  if (!tree.exists('bun.lock') && !tree.exists('bun.lockb')) {
    if (tree.exists('pnpm-workspace.yaml') || tree.exists('yarn.lock')) {
      throw new Error(
        "AgentForge's generators write Bun's catalog; this workspace uses another package manager",
      );
    }
    return false;
  }
  return (await awsNxPluginConfig(tree))?.packageManager?.catalogs !== false;
}

/**
 * Declares the dependencies an agentic project needs at AgentForge's peer
 * ranges (`declareDependencies`).
 */
export async function declareAgenticProjectDependencies(
  tree: Tree,
): Promise<void> {
  await declareDependencies(
    tree,
    Object.fromEntries(
      AGENTIC_PROJECT_DEPENDENCIES.map((name) => [name, peerRange(name)]),
    ),
  );
}

/**
 * Declares dependencies at the given ranges: in the root catalog when the
 * workspace keeps one, else in the root manifest. One already declared is
 * kept when it is within the range, and refused when it is not.
 */
export async function declareDependencies(
  tree: Tree,
  ranges: Readonly<Record<string, string>>,
): Promise<void> {
  const catalogs = await catalogsEnabled(tree);
  updateJson<Record<string, unknown>>(tree, 'package.json', (manifest) => {
    const field = catalogs ? 'catalog' : 'dependencies';
    const declared = { ...((manifest[field] ?? {}) as Record<string, string>) };
    const outOfRange: string[] = [];
    for (const [name, range] of Object.entries(ranges)) {
      const existing = declared[name];
      if (existing === undefined) {
        declared[name] = range;
      } else if (!withinRange(existing, range)) {
        outOfRange.push(`${name}@${existing} (AgentForge needs ${range})`);
      }
    }
    if (outOfRange.length > 0) {
      throw new Error(
        `the root package.json ${field} declares dependencies outside AgentForge's peer ranges: ${outOfRange.join(', ')}`,
      );
    }
    return { ...manifest, [field]: declared };
  });
}

/**
 * The version a dependency is declared at for the whole workspace: the root
 * catalog's entry when the workspace keeps one, else the root manifest's.
 * Throws when it is not declared.
 */
export async function declaredVersion(
  tree: Tree,
  name: string,
): Promise<string> {
  const field = (await catalogsEnabled(tree)) ? 'catalog' : 'dependencies';
  const version = readJson<Record<string, Record<string, string> | undefined>>(
    tree,
    'package.json',
  )[field]?.[name];
  if (version === undefined) {
    throw new Error(`the root package.json ${field} does not declare ${name}`);
  }
  return version;
}

/** Whether a declared version or range stays within AgentForge's range. */
function withinRange(declared: string, range: string): boolean {
  if (validRange(declared) === null) return false;
  const lowest = minVersion(declared);
  return lowest !== null && satisfies(lowest, range);
}

/** The specifier a generated manifest gives one of AgentForge's peers: the catalog's, or AgentForge's range. */
export async function dependencySpecifier(
  tree: Tree,
  name: string,
): Promise<string> {
  return (await catalogsEnabled(tree)) ? 'catalog:' : peerRange(name);
}

/**
 * How the workspace depends on AgentForge: the root manifest's own specifier,
 * which a generated manifest repeats — `workspace:*` in AgentForge's own
 * repository, a version in a consumer's.
 */
export function agentforgeSpecifier(tree: Tree): string {
  const manifest = readJson<Record<string, Record<string, string> | undefined>>(
    tree,
    'package.json',
  );
  const specifier =
    manifest.dependencies?.[AGENTFORGE] ??
    manifest.devDependencies?.[AGENTFORGE];
  if (specifier === undefined) {
    throw new Error(
      `the root package.json does not depend on ${AGENTFORGE}; add it with nx add ${AGENTFORGE}`,
    );
  }
  return specifier;
}
