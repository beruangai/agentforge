import {
  addProjectConfiguration,
  readJson,
  readProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import syncGenerator from '../sync/generator.ts';
import workflowProjectGenerator from './generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('../../__fixtures__/shared-constructs.ts'),
);

const ROOT = 'packages/examples/golden-kata-workflows';
const CONSTRUCTS = 'packages/common/constructs/src/app';
let tree: Tree;

const generate = () =>
  workflowProjectGenerator(tree, {
    name: 'golden-kata-workflows',
    directory: 'packages/examples',
  });

beforeEach(() => {
  tree = workspaceTree();
});

describe('workflow-project', () => {
  it('generates the project, its worker, a placeholder workflow and its test, and no connections', async () => {
    await generate();
    const configuration = readProjectConfiguration(
      tree,
      '@proj/golden-kata-workflows',
    );
    expect(configuration.metadata).toEqual({
      generator: '@beruangai/agentforge:workflow-project',
      components: [],
      agentforge: { detached: { files: [], targets: [] } },
    });
    const files = treeFiles(tree, ROOT);
    expect(Object.keys(files).sort()).toMatchSnapshot();
    for (const [path, content] of Object.entries(files)) {
      expect(content).toMatchSnapshot(path);
    }
    expect(configuration.targets).toMatchSnapshot('targets');
    const project = `${CONSTRUCTS}/workflow-projects/golden-kata-workflows`;
    expect(tree.read(`${project}/project.ts`, 'utf8')).toMatchSnapshot(
      'project construct',
    );
    expect(tree.read(`${project}/index.ts`, 'utf8')).toMatchSnapshot(
      'project index',
    );
    expect(tree.read(`${CONSTRUCTS}/index.ts`, 'utf8')).toBe(
      "export * from './workflow-projects/index.js';\n",
    );
    expect(
      readProjectConfiguration(tree, '@proj/common-constructs').targets
        ?.assemble,
    ).toEqual({ dependsOn: ['@proj/golden-kata-workflows:assemble'] });
  });

  it("declares the Temporal packages in the workspace's catalog", async () => {
    await generate();
    expect(readJson(tree, 'package.json').catalog).toMatchObject({
      '@temporalio/worker': expect.stringMatching(/^\^1\./),
      '@temporalio/testing': expect.stringMatching(/^\^1\./),
    });
  });

  it('changes nothing when generated again, or synced', async () => {
    await generate();
    const before = treeFiles(tree);
    await generate();
    expect(treeFiles(tree)).toEqual(before);
    expect(await syncGenerator(tree)).toEqual({});
  });

  it('keeps an edited workflow and restores a drifted worker entry', async () => {
    await generate();
    const worker = tree.read(`${ROOT}/worker.ts`, 'utf8');
    tree.write(`${ROOT}/workflows/example.ts`, '// mine\n');
    tree.write(`${ROOT}/worker.ts`, '// drifted\n');
    expect((await syncGenerator(tree)).outOfSyncDetails).toEqual([
      `file ${ROOT}/worker.ts`,
    ]);
    expect(tree.read(`${ROOT}/workflows/example.ts`, 'utf8')).toBe('// mine\n');
    expect(tree.read(`${ROOT}/worker.ts`, 'utf8')).toBe(worker);
  });

  it('refuses a name another project holds, writing nothing', async () => {
    addProjectConfiguration(tree, '@proj/golden-kata-workflows', {
      root: `${ROOT}`,
      targets: {},
    });
    const before = treeFiles(tree);
    await expect(generate()).rejects.toThrow(
      `@proj/golden-kata-workflows at ${ROOT} collides with the workflow project @proj/golden-kata-workflows at ${ROOT}`,
    );
    expect(treeFiles(tree)).toEqual(before);
  });
});
