import { readJson, type Tree, updateJson } from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceTree } from './__fixtures__/workspace-tree.ts';
import agentGenerator from './generators/agent/generator.ts';
import agenticProjectGenerator from './generators/agentic-project/generator.ts';
import syncGenerator from './generators/sync/generator.ts';
import workflowProjectGenerator from './generators/workflow-project/generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('./__fixtures__/shared-constructs.ts'),
);

const AGENTIC = 'packages/rnd/agentic';
const WORKFLOW = 'packages/rnd/worker';
let tree: Tree;

const workspaces = (): unknown =>
  readJson<{ workspaces: unknown }>(tree, 'package.json').workspaces;

function rootGlobs(globs: unknown): void {
  updateJson(tree, 'package.json', (manifest) => ({
    ...manifest,
    workspaces: globs,
  }));
}

async function generateBoth(): Promise<void> {
  await agenticProjectGenerator(tree, {
    name: 'rnd',
    directory: 'packages/rnd',
    subDirectory: 'agentic',
  });
  await agentGenerator(tree, { project: 'rnd', name: 'researcher' });
  await workflowProjectGenerator(tree, {
    name: 'rnd-workflows',
    directory: 'packages/rnd',
    subDirectory: 'worker',
  });
}

beforeEach(() => {
  tree = workspaceTree();
});

describe('the layer manifests and the root workspace', () => {
  it('keeps them out of deep globs, one negation per project, and sync then finds nothing to do', async () => {
    rootGlobs(['apps/**', 'packages/**']);
    await generateBoth();
    expect(workspaces()).toEqual([
      'apps/**',
      'packages/**',
      `!${AGENTIC}/{agents,base}/**`,
      `!${WORKFLOW}/container`,
    ]);
    expect(await syncGenerator(tree)).toEqual({});
  });

  it('adds nothing for globs that do not reach them', async () => {
    rootGlobs(['packages/*', 'packages/rnd/*']);
    await generateBoth();
    expect(workspaces()).toEqual(['packages/*', 'packages/rnd/*']);
  });

  it('adds nothing where the consumer already excludes them, and keeps its entries in order', async () => {
    const own = [
      'packages/**',
      `!${AGENTIC}/{agents,base}/**`,
      '!packages/rnd/worker/container',
      '!packages/legacy',
    ];
    rootGlobs(own);
    await generateBoth();
    expect(workspaces()).toEqual(own);
  });

  it('writes them into the object form, beside its other keys', async () => {
    rootGlobs({ packages: ['packages/**'], nohoist: ['x'] });
    await generateBoth();
    expect(workspaces()).toEqual({
      packages: [
        'packages/**',
        `!${AGENTIC}/{agents,base}/**`,
        `!${WORKFLOW}/container`,
      ],
      nohoist: ['x'],
    });
  });

  it('removes a project’s negation once the project is gone, and reports it', async () => {
    rootGlobs(['packages/**', '!packages/legacy']);
    await generateBoth();
    tree.delete(WORKFLOW);
    expect(await syncGenerator(tree)).toMatchObject({
      outOfSyncDetails: ['file package.json (workspaces)'],
    });
    expect(workspaces()).toEqual([
      'packages/**',
      '!packages/legacy',
      `!${AGENTIC}/{agents,base}/**`,
    ]);
  });

  it('refuses a root manifest that declares no workspaces', async () => {
    updateJson(
      tree,
      'package.json',
      ({ workspaces: _, ...manifest }) => manifest,
    );
    await expect(
      agenticProjectGenerator(tree, { name: 'rnd' }),
    ).rejects.toThrow('package.json declares no workspaces');
  });
});
