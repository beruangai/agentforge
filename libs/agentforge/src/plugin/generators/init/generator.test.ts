import { readJson, readNxJson, type Tree } from '@nx/devkit';
import { beforeEach, describe, expect, it } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import { peerRange } from '../../workspace-dependencies.ts';
import initGenerator from './generator.ts';

let tree: Tree;

describe('init', () => {
  beforeEach(() => {
    tree = workspaceTree();
  });

  it("declares an agentic project's dependencies in the catalog, at AgentForge's ranges", async () => {
    await initGenerator(tree);
    const { catalog } = readJson(tree, 'package.json');
    expect(catalog.zod).toBe(peerRange('zod'));
    expect(catalog['@orpc/contract']).toBe(peerRange('@orpc/contract'));
    expect(catalog['aws-cdk-lib']).toBe(peerRange('aws-cdk-lib'));
  });

  it('declares them in the root manifest when the workspace keeps no catalog', async () => {
    tree = workspaceTree({ catalogs: false });
    await initGenerator(tree);
    const manifest = readJson(tree, 'package.json');
    expect(manifest.catalog).toBeUndefined();
    expect(manifest.dependencies.zod).toBe(peerRange('zod'));
  });

  it('keeps a version within range, and refuses one outside it', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        ...readJson(tree, 'package.json'),
        catalog: { zod: '4.9.0' },
      }),
    );
    await initGenerator(tree);
    expect(readJson(tree, 'package.json').catalog.zod).toBe('4.9.0');
    tree.write(
      'package.json',
      JSON.stringify({
        ...readJson(tree, 'package.json'),
        catalog: { zod: '3.25.0' },
      }),
    );
    await expect(initGenerator(tree)).rejects.toThrow(
      `zod@3.25.0 (AgentForge needs ${peerRange('zod')})`,
    );
  });

  it("attaches the sync generator to the plugin's lock and image tasks, once", async () => {
    await initGenerator(tree);
    const before = treeFiles(tree);
    await initGenerator(tree);
    expect(treeFiles(tree)).toEqual(before);
    const { targetDefaults } = readNxJson(tree) ?? {};
    expect(targetDefaults?.['@beruangai/agentforge:lock']).toEqual({
      syncGenerators: ['@beruangai/agentforge:sync'],
    });
    expect(targetDefaults?.['@beruangai/agentforge:image']).toEqual({
      syncGenerators: ['@beruangai/agentforge:sync'],
    });
  });
});
