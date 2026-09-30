import {
  readJson,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import agentGenerator from '../agent/generator.ts';
import agenticProjectGenerator from '../agentic-project/generator.ts';
import syncGenerator from '../sync/generator.ts';
import workflowProjectGenerator from '../workflow-project/generator.ts';
import connectionGenerator from './generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('../../__fixtures__/shared-constructs.ts'),
);

const ROOT = 'packages/examples/golden-kata-workflows';
const CONSTRUCT = `packages/common/constructs/src/app/workflow-projects/golden-kata-workflows/project.ts`;
let tree: Tree;
const read = (path: string) => tree.read(path, 'utf8') ?? '';

const connect = (agenticProject: string) =>
  connectionGenerator(tree, {
    project: 'golden-kata-workflows',
    agenticProject,
  });

/** What spans the connections, compared whole. */
const spanning = () => ({
  activities: read(`${ROOT}/agents/activities.ts`),
  workflow: read(`${ROOT}/agents/workflow.ts`),
  construct: read(CONSTRUCT),
  dependencies: readJson(tree, `${ROOT}/package.json`).dependencies,
  paths: readJson(tree, `${ROOT}/tsconfig.lib.json`).compilerOptions.paths,
});

beforeEach(async () => {
  tree = workspaceTree();
  await agenticProjectGenerator(tree, {
    name: 'golden-kata',
    directory: 'packages/examples',
  });
  await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
  await agentGenerator(tree, { project: 'golden-kata', name: 'grader' });
  await agenticProjectGenerator(tree, { name: 'smoke-coverage' });
  await agentGenerator(tree, {
    project: 'smoke-coverage',
    name: 'hello-agent',
  });
  await workflowProjectGenerator(tree, {
    name: 'golden-kata-workflows',
    directory: 'packages/examples',
  });
});

describe('connection', () => {
  it('records the connection and renders what spans it', async () => {
    await connect('golden-kata');
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata-workflows').metadata
        ?.components,
    ).toEqual([
      {
        generator: '@beruangai/agentforge:connection',
        name: 'golden-kata',
        path: '../golden-kata',
        packageName: '@proj/golden-kata',
        key: 'goldenKata',
      },
    ]);
    const rendered = spanning();
    expect(rendered.activities).toMatchSnapshot('activities of one');
    expect(rendered.workflow).toMatchSnapshot('workflow of one');
    expect(rendered.construct).toMatchSnapshot('construct of one');
    expect(rendered.dependencies['@proj/golden-kata']).toBe('workspace:*');
    expect(rendered.paths).toEqual({
      '@proj/golden-kata-base/*': ['../golden-kata/base/agentic/*.ts'],
    });
  });

  it('adds a second agentic project everywhere', async () => {
    await connect('golden-kata');
    await connect('smoke-coverage');
    const rendered = spanning();
    expect(rendered.activities).toMatchSnapshot('activities of two');
    expect(rendered.workflow).toMatchSnapshot('workflow of two');
    expect(rendered.construct).toMatchSnapshot('construct of two');
    expect(rendered.dependencies).toMatchObject({
      '@proj/golden-kata': 'workspace:*',
      '@proj/smoke-coverage': 'workspace:*',
    });
    expect(Object.keys(rendered.paths).sort()).toEqual([
      '@proj/golden-kata-base/*',
      '@proj/smoke-coverage-base/*',
    ]);
  });

  it('changes nothing when connected again, or synced', async () => {
    await connect('golden-kata');
    const before = treeFiles(tree);
    await connect('golden-kata');
    expect(treeFiles(tree)).toEqual(before);
    expect(await syncGenerator(tree)).toEqual({});
  });

  it('drops a removed record from every maintained artifact', async () => {
    const unconnected = spanning();
    await connect('golden-kata');
    await connect('smoke-coverage');
    const configuration = readProjectConfiguration(
      tree,
      '@proj/golden-kata-workflows',
    );
    updateProjectConfiguration(tree, '@proj/golden-kata-workflows', {
      ...configuration,
      metadata: { ...configuration.metadata, components: [] },
    });
    await syncGenerator(tree);
    expect(spanning()).toEqual(unconnected);
    for (const content of Object.values(treeFiles(tree, ROOT))) {
      expect(content).not.toMatch(/golden-kata\/client|smoke-coverage/);
    }
  });

  it('refuses from a project that is not a workflow project, writing nothing', async () => {
    const before = treeFiles(tree);
    await expect(
      connectionGenerator(tree, {
        project: 'smoke-coverage',
        agenticProject: 'golden-kata',
      }),
    ).rejects.toThrow('@proj/smoke-coverage is not a workflow project');
    expect(treeFiles(tree)).toEqual(before);
  });

  it('refuses to a project that is not an agentic project, writing nothing', async () => {
    const before = treeFiles(tree);
    await expect(connect('golden-kata-workflows')).rejects.toThrow(
      '@proj/golden-kata-workflows is not an agentic project',
    );
    expect(treeFiles(tree)).toEqual(before);
  });
});
