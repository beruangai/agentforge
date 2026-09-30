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
import { applyAndFormat } from '../../artifacts/project-artifacts.ts';
import {
  TEMPORAL_TESTING,
  WORKFLOW_PROJECT_TEMPORAL_PACKAGES,
  workflowProjectRendering,
} from '../../artifacts/workflow-project.ts';
import { workflowProjectScaffolds } from '../../artifacts/workflow-scaffolds.ts';
import { KebabNameField, parseName, scopeOf } from '../../names.ts';
import {
  isWorkflowProject,
  readWorkflowProject,
  WORKFLOW_PROJECT_GENERATOR,
} from '../../project-record.ts';
import {
  catalogsEnabled,
  declareDependencies,
  peerRange,
} from '../../workspace-dependencies.ts';

export interface WorkflowProjectGeneratorSchema {
  readonly name: string;
  /** Where the project is created; `packages` by default. */
  readonly directory?: string;
}

/** What the shared constructs generator must be told it may add. */
const SHARED_CONSTRUCTS_DECLARATION = {
  ts: [
    { name: 'constructs' },
    { name: 'aws-cdk-lib' },
    { name: '@types/node' },
  ],
  py: [],
} as const;

/**
 * A workflow project: a placeholder workflow and activity, a unit test of
 * the workflow against the local server, one worker, and no connections —
 * each artifact maintained or scaffolded, as an agentic project's. The
 * Temporal packages are declared for the workspace at AgentForge's ranges.
 * Generating one that exists changes nothing in a synced workspace; a
 * different project where it would go is refused before anything is written.
 */
export default async function workflowProjectGenerator(
  tree: Tree,
  options: WorkflowProjectGeneratorSchema,
): Promise<GeneratorCallback> {
  const name = parseName(KebabNameField, 'workflow project name', options.name);
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
  const temporalRange = peerRange('@temporalio/worker');
  if (existing !== undefined) {
    const [projectName, configuration] = existing;
    if (
      projectName !== packageName ||
      configuration.root !== root ||
      !isWorkflowProject(configuration)
    ) {
      throw new Error(
        `${projectName} at ${configuration.root} collides with the workflow project ${packageName} at ${root}`,
      );
    }
  } else {
    if (tree.exists(root) && tree.children(root).length > 0) {
      throw new Error(
        `${root} exists and is not a project; the workflow project ${packageName} would collide with it`,
      );
    }
    tree.write(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: packageName,
          version: '0.0.0',
          private: true,
          type: 'module',
          devDependencies: {
            [TEMPORAL_TESTING]: (await catalogsEnabled(tree))
              ? 'catalog:'
              : temporalRange,
          },
        },
        null,
        2,
      )}\n`,
    );
    // As @aws/nx-plugin's TypeScript projects, and an agentic project's.
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
        generator: WORKFLOW_PROJECT_GENERATOR,
        components: [],
        agentforge: { detached: { files: [], targets: [] } },
      },
      targets: {},
    });
  }
  await declareDependencies(tree, {
    ...Object.fromEntries(
      WORKFLOW_PROJECT_TEMPORAL_PACKAGES.map((dependency) => [
        dependency,
        peerRange(dependency),
      ]),
    ),
    [TEMPORAL_TESTING]: temporalRange,
  });
  const project = readWorkflowProject(tree, packageName);
  if (existing === undefined) {
    // Written once, with the project: a placeholder the consumer removed
    // stays removed when the project is generated again.
    for (const file of workflowProjectScaffolds(project)) {
      tree.write(file.path, file.content);
    }
  }
  await sharedConstructsGenerator(
    tree,
    { iac: 'cdk' },
    SHARED_CONSTRUCTS_DECLARATION,
  );
  await applyAndFormat(tree, [await workflowProjectRendering(tree, project)]);
  return () => installPackagesTask(tree);
}
