import { relative } from 'node:path';
import { sharedConstructsGenerator } from '@aws/nx-plugin/sdk/ts';
import {
  addProjectConfiguration,
  type GeneratorCallback,
  getProjects,
  installPackagesTask,
  readJson,
  type Tree,
  writeJson,
} from '@nx/devkit';
import {
  agenticProjectRendering,
  applyAndFormat,
} from '../../artifacts/project-artifacts.ts';
import { baseScaffolds } from '../../artifacts/scaffolds.ts';
import { CONTAINER_ROOT_DEPENDENCIES } from '../../container/container-workspace.ts';
import { KebabNameField, parseName, scopeOf } from '../../names.ts';
import {
  AGENTIC_PROJECT_GENERATOR,
  isAgenticProject,
  readAgenticProject,
} from '../../project-record.ts';
import { dependencySpecifier } from '../../workspace-dependencies.ts';

export interface AgenticProjectGeneratorSchema {
  readonly name: string;
  /** Where the project is created; `packages` by default. */
  readonly directory?: string;
}

/** What the host package depends on for its agents' code and its client to typecheck. */
const HOST_DEPENDENCIES = [
  ...CONTAINER_ROOT_DEPENDENCIES,
  '@aws-sdk/client-bedrock-agentcore',
  '@aws-sdk/client-appconfigdata',
] as const;

/** What the shared constructs generator must be told it may add. */
const SHARED_CONSTRUCTS_DECLARATION = {
  ts: [
    { name: 'constructs' },
    { name: 'aws-cdk-lib' },
    { name: '@types/node' },
  ],
  py: [],
} as const;

function writeIfAbsent(tree: Tree, path: string, content: string): void {
  if (!tree.exists(path)) tree.write(path, content);
}

/**
 * An agentic project: a host package holding the base layer every agent
 * shares — modules, options, Claude configuration, dependencies — its image
 * targets, its client and its construct, and no agents. Generating one that
 * exists changes nothing in a synced workspace; a different project where it
 * would go is refused before anything is written.
 */
export default async function agenticProjectGenerator(
  tree: Tree,
  options: AgenticProjectGeneratorSchema,
): Promise<GeneratorCallback> {
  const name = parseName(KebabNameField, 'agentic project name', options.name);
  const root = `${options.directory ?? 'packages'}/${name}`;
  const { name: rootPackage } = readJson<{ name?: string }>(
    tree,
    'package.json',
  );
  if (rootPackage === undefined) {
    throw new Error('the root package.json names no package');
  }
  const packageName = `@${scopeOf(rootPackage)}/${name}`;
  const existing = [...getProjects(tree).entries()].find(
    ([projectName, configuration]) =>
      configuration.root === root || projectName === packageName,
  );
  if (existing !== undefined) {
    const [projectName, configuration] = existing;
    if (
      projectName !== packageName ||
      configuration.root !== root ||
      !isAgenticProject(configuration)
    ) {
      throw new Error(
        `${projectName} at ${configuration.root} collides with the agentic project ${packageName} at ${root}`,
      );
    }
  } else {
    if (tree.exists(root) && tree.children(root).length > 0) {
      throw new Error(
        `${root} exists and is not a project; the agentic project ${packageName} would collide with it`,
      );
    }
    const dependencies: Record<string, string> = {};
    for (const dependency of HOST_DEPENDENCIES) {
      dependencies[dependency] = await dependencySpecifier(tree, dependency);
    }
    tree.write(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: packageName,
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    // As @aws/nx-plugin's TypeScript projects: a solution tsconfig.json the
    // workspace's references and inferred typecheck build, and a
    // tsconfig.lib.json emitting only under dist/.
    const toWorkspaceRoot = relative(root, '.');
    writeJson(tree, `${root}/tsconfig.json`, {
      extends: `${toWorkspaceRoot}/tsconfig.base.json`,
      compilerOptions: {},
      files: [],
      include: [],
      references: [{ path: './tsconfig.lib.json' }],
    });
    writeJson(tree, `${root}/tsconfig.lib.json`, {
      extends: './tsconfig.json',
      compilerOptions: {
        rootDir: '.',
        outDir: `${toWorkspaceRoot}/dist/${root}/tsc`,
        tsBuildInfoFile: `${toWorkspaceRoot}/dist/${root}/tsc/tsconfig.lib.tsbuildinfo`,
        allowImportingTsExtensions: true,
      },
      include: ['**/*.ts'],
    });
    addProjectConfiguration(tree, packageName, {
      root,
      sourceRoot: root,
      projectType: 'library',
      metadata: {
        generator: AGENTIC_PROJECT_GENERATOR,
        components: [],
        agentforge: { detached: { files: [], targets: [] } },
      },
      targets: {},
    });
  }
  const project = readAgenticProject(tree, packageName);
  for (const file of baseScaffolds(project)) {
    writeIfAbsent(tree, file.path, file.content);
  }
  await sharedConstructsGenerator(
    tree,
    { iac: 'cdk' },
    SHARED_CONSTRUCTS_DECLARATION,
  );
  await applyAndFormat(tree, [agenticProjectRendering(tree, project)]);
  return () => installPackagesTask(tree);
}
