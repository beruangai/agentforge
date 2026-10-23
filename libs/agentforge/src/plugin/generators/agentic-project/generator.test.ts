import {
  readJson,
  readProjectConfiguration,
  type Tree,
  writeJson,
} from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_NAMES } from '#core/contract/framework.ts';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import { peerRange } from '../../workspace-dependencies.ts';
import agentGenerator from '../agent/generator.ts';
import syncGenerator from '../sync/generator.ts';
import agenticProjectGenerator from './generator.ts';
import schema from './schema.json' with { type: 'json' };

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

  it('places the project in the sub directory given, apart from its name, and keeps it synced there', async () => {
    await agenticProjectGenerator(tree, {
      name: 'rnd',
      directory: 'apps/rnd',
      subDirectory: 'agentic',
    });
    await agentGenerator(tree, { project: 'rnd', name: 'researcher' });
    expect(readProjectConfiguration(tree, '@proj/rnd').root).toBe(
      'apps/rnd/agentic',
    );
    expect(tree.exists('apps/rnd/agentic/agents/researcher/Dockerfile')).toBe(
      true,
    );
    const before = treeFiles(tree);
    await syncGenerator(tree);
    expect(treeFiles(tree)).toEqual(before);
  });

  it('records the claude framework by default, and declares its peers', async () => {
    await agenticProjectGenerator(tree, { name: 'golden-kata' });
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').metadata?.agentforge
        .framework,
    ).toBe('claude');
    const { catalog } = readJson(tree, 'package.json');
    for (const peer of [
      '@anthropic-ai/claude-agent-sdk',
      '@anthropic-ai/sdk',
    ]) {
      expect(catalog[peer]).toBe(peerRange(peer));
    }
  });

  it('generates a strands project: its base layer, options and instruction file, and its peers', async () => {
    await agenticProjectGenerator(tree, {
      name: 'strands-smoke',
      directory: 'packages/examples',
      framework: 'strands',
    });
    expect(
      readProjectConfiguration(tree, '@proj/strands-smoke').metadata?.agentforge
        .framework,
    ).toBe('strands');
    const files = treeFiles(tree, 'packages/examples/strands-smoke');
    expect(Object.keys(files).sort()).toMatchSnapshot();
    for (const [path, content] of Object.entries(files)) {
      expect(content).toMatchSnapshot(`strands ${path}`);
    }
    const { catalog } = readJson(tree, 'package.json');
    for (const peer of ['@strands-agents/sdk', '@anthropic-ai/sdk']) {
      expect(catalog[peer]).toBe(peerRange(peer));
    }
    expect(catalog['@anthropic-ai/claude-agent-sdk']).toBeUndefined();
  });

  it('refuses a framework AgentForge does not provide, naming those it does, writing nothing', async () => {
    const before = treeFiles(tree);
    await expect(
      agenticProjectGenerator(tree, {
        name: 'golden-kata',
        framework: 'langgraph' as never,
      }),
    ).rejects.toThrow(
      'framework "langgraph" is not one AgentForge provides: claude, strands',
    );
    expect(treeFiles(tree)).toEqual(before);
  });

  it('offers exactly the provided frameworks, claude by default', () => {
    expect(schema.properties.framework.enum).toEqual([...FRAMEWORK_NAMES]);
    expect(schema.properties.framework.default).toBe('claude');
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
