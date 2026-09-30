import { type Tree, writeJson } from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import agenticProjectGenerator from './generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('../../__fixtures__/shared-constructs.ts'),
);

let tree: Tree;

beforeEach(() => {
  tree = workspaceTree();
});

describe('agentic-project', () => {
  it('generates a base layer, its targets, client and construct, and no agents', async () => {
    await agenticProjectGenerator(tree, {
      name: 'golden-kata',
      directory: 'packages/examples',
    });
    const files = treeFiles(tree, 'packages/examples/golden-kata');
    expect(Object.keys(files).sort()).toMatchSnapshot();
    for (const [path, content] of Object.entries(files)) {
      expect(content).toMatchSnapshot(path);
    }
    expect(
      tree.read(
        'packages/common/constructs/src/app/agentic-projects/golden-kata/project.ts',
        'utf8',
      ),
    ).toMatchSnapshot('project construct');
  });

  it('changes nothing when generated again', async () => {
    await agenticProjectGenerator(tree, { name: 'golden-kata' });
    const before = treeFiles(tree);
    await agenticProjectGenerator(tree, { name: 'golden-kata' });
    expect(treeFiles(tree)).toEqual(before);
  });

  it('refuses a name where a different project exists, writing nothing', async () => {
    writeJson(tree, 'packages/golden-kata/project.json', {
      name: '@proj/golden-kata',
      root: 'packages/golden-kata',
    });
    const before = treeFiles(tree);
    await expect(
      agenticProjectGenerator(tree, { name: 'golden-kata' }),
    ).rejects.toThrow(
      '@proj/golden-kata at packages/golden-kata collides with the agentic project @proj/golden-kata at packages/golden-kata',
    );
    expect(treeFiles(tree)).toEqual(before);
  });

  it('refuses an invalid name', async () => {
    await expect(
      agenticProjectGenerator(tree, { name: 'GoldenKata' }),
    ).rejects.toThrow('agentic project name "GoldenKata" must be kebab-case');
  });
});
