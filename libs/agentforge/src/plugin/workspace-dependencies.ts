import { stripTypeScriptTypes } from 'node:module';
import { readJson, type Tree, updateJson } from '@nx/devkit';
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

/** `aws-nx-plugin.config.mts`'s default export, evaluated with its types stripped. */
async function awsNxPluginConfig(
  tree: Tree,
): Promise<{ packageManager?: { catalogs?: boolean } } | undefined> {
  const source = tree.read(AWS_NX_PLUGIN_CONFIG, 'utf8');
  if (source === null) return undefined;
  let module: { default?: unknown };
  try {
    module = (await import(
      `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`
    )) as { default?: unknown };
  } catch (error) {
    throw new Error(
      `${AWS_NX_PLUGIN_CONFIG} cannot be read: AgentForge evaluates it on its own, so it may import only types`,
      { cause: error },
    );
  }
  return module.default as { packageManager?: { catalogs?: boolean } };
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
 * ranges: in the root catalog when the workspace keeps one, else in the root
 * manifest. One already declared is kept when it is within AgentForge's
 * range, and refused when it is not.
 */
export async function declareAgenticProjectDependencies(
  tree: Tree,
): Promise<void> {
  const catalogs = await catalogsEnabled(tree);
  updateJson<Record<string, unknown>>(tree, 'package.json', (manifest) => {
    const field = catalogs ? 'catalog' : 'dependencies';
    const declared = { ...((manifest[field] ?? {}) as Record<string, string>) };
    const outOfRange: string[] = [];
    for (const name of AGENTIC_PROJECT_DEPENDENCIES) {
      const range = peerRange(name);
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
