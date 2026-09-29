import {
  readProjectConfiguration,
  type Tree,
  updateJson,
  updateProjectConfiguration,
} from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import agentGenerator from '../agent/generator.ts';
import agenticProjectGenerator from '../agentic-project/generator.ts';
import syncGenerator from './generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('../../__fixtures__/shared-constructs.ts'),
);

const ROOT = 'packages/golden-kata';
let tree: Tree;

function detach(detached: { files?: string[]; targets?: string[] }): void {
  const project = readProjectConfiguration(tree, '@proj/golden-kata');
  updateProjectConfiguration(tree, '@proj/golden-kata', {
    ...project,
    metadata: {
      ...project.metadata,
      agentforge: {
        detached: { files: [], targets: [], ...detached },
      },
    },
  });
}

beforeEach(async () => {
  tree = workspaceTree();
  await agenticProjectGenerator(tree, { name: 'golden-kata' });
  await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
});

describe('sync', () => {
  it('reports nothing, and changes nothing, on what the generators produced', async () => {
    const before = treeFiles(tree);
    expect(await syncGenerator(tree)).toEqual({});
    expect(treeFiles(tree)).toEqual(before);
  });

  it('reports a drifted file and a drifted target, and restores both', async () => {
    const before = treeFiles(tree);
    tree.write(`${ROOT}/agents/writer/Dockerfile`, 'FROM scratch\n');
    const project = readProjectConfiguration(tree, '@proj/golden-kata');
    updateProjectConfiguration(tree, '@proj/golden-kata', {
      ...project,
      targets: {
        ...project.targets,
        image: { ...project.targets?.image, cache: true },
      },
    });
    const result = await syncGenerator(tree);
    expect(result.outOfSyncDetails).toEqual([
      `file ${ROOT}/agents/writer/Dockerfile`,
      'target @proj/golden-kata:image',
    ]);
    expect(result.outOfSyncMessage).toContain('metadata.agentforge.detached');
    expect(treeFiles(tree)).toEqual(before);
  });

  it('keeps the consumer keys beside the maintained ones', async () => {
    updateJson(tree, `${ROOT}/package.json`, (manifest) => ({
      ...manifest,
      description: 'the consumer’s',
      exports: { './mine': './mine.ts' },
      dependencies: { ...manifest.dependencies, 'left-pad': '1.3.0' },
    }));
    const result = await syncGenerator(tree);
    expect(result.outOfSyncDetails).toEqual([`file ${ROOT}/package.json`]);
    const manifest = JSON.parse(
      tree.read(`${ROOT}/package.json`, 'utf8') ?? '',
    );
    expect(manifest.description).toBe('the consumer’s');
    expect(manifest.dependencies['left-pad']).toBe('1.3.0');
    expect(manifest.exports).toEqual({
      './client': './client.ts',
      './writer': './agents/writer/agent/contract.ts',
      './*': './base/agentic/*.ts',
    });
  });

  it('keeps an edited scaffolded file, through sync and regeneration', async () => {
    const contract = `${ROOT}/agents/writer/agent/contract.ts`;
    tree.write(contract, '// mine\n');
    expect(await syncGenerator(tree)).toEqual({});
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    expect(tree.read(contract, 'utf8')).toBe('// mine\n');
  });

  it('leaves a detached file and target as the consumer wrote them', async () => {
    const dockerfile = `${ROOT}/agents/writer/Dockerfile`;
    detach({ files: [dockerfile], targets: ['image'] });
    tree.write(dockerfile, 'FROM mine\n');
    const project = readProjectConfiguration(tree, '@proj/golden-kata');
    updateProjectConfiguration(tree, '@proj/golden-kata', {
      ...project,
      targets: { ...project.targets, image: { executor: 'nx:noop' } },
    });
    expect(await syncGenerator(tree)).toEqual({});
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    expect(tree.read(dockerfile, 'utf8')).toBe('FROM mine\n');
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').targets?.image,
    ).toEqual({ executor: 'nx:noop' });
  });

  it('fails on a detachment that names nothing maintained, naming it', async () => {
    detach({
      files: [`${ROOT}/agents/writer/agent/contract.ts`],
      targets: ['typecheck'],
    });
    await expect(syncGenerator(tree)).rejects.toThrow(
      `@proj/golden-kata's metadata.agentforge.detached names what AgentForge does not maintain: file ${ROOT}/agents/writer/agent/contract.ts, target typecheck`,
    );
  });
});
