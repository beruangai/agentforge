import {
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeFiles, workspaceTree } from '../../__fixtures__/workspace-tree.ts';
import agenticProjectGenerator from '../agentic-project/generator.ts';
import syncGenerator from '../sync/generator.ts';
import agentGenerator from './generator.ts';

vi.mock(
  '@aws/nx-plugin/sdk/ts',
  () => import('../../__fixtures__/shared-constructs.ts'),
);

const ROOT = 'packages/examples/golden-kata';
const CONSTRUCTS = 'packages/common/constructs/src/app';
let tree: Tree;

const targetsOf = () =>
  Object.keys(
    readProjectConfiguration(tree, '@proj/golden-kata').targets ?? {},
  );
const read = (path: string) => tree.read(path, 'utf8') ?? '';

beforeEach(async () => {
  tree = workspaceTree();
  await agenticProjectGenerator(tree, {
    name: 'golden-kata',
    directory: 'packages/examples',
  });
});

describe('agent', () => {
  it("generates the agent's folder, record, image, entries and construct", async () => {
    await agentGenerator(tree, {
      project: 'golden-kata',
      name: 'writer',
      procedure: 'Write',
    });
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').metadata?.components,
    ).toEqual([
      {
        generator: '@beruangai/agentforge:agent',
        name: 'writer',
        path: 'agents/writer',
        runtimeConfigKey: 'GoldenKataWriter',
        containerName: 'proj-golden-kata-writer',
      },
    ]);
    const files = treeFiles(tree, `${ROOT}/agents/writer`);
    expect(Object.keys(files).sort()).toMatchSnapshot();
    for (const [path, content] of Object.entries(files)) {
      expect(content).toMatchSnapshot(path);
    }
    expect(read(`${ROOT}/client.ts`)).toMatchSnapshot('client.ts');
    expect(read(`${ROOT}/package.json`)).toMatchSnapshot('package.json');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/agents/writer/agent.ts`),
    ).toMatchSnapshot('agent construct');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/project.ts`),
    ).toMatchSnapshot('project construct');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/index.ts`),
    ).toMatchSnapshot('project index');
    expect(read(`${CONSTRUCTS}/index.ts`)).toMatchSnapshot('app index');
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').targets,
    ).toMatchSnapshot('targets');
    expect(
      readProjectConfiguration(tree, '@proj/common-constructs').targets
        ?.assemble,
    ).toEqual({ dependsOn: ['@proj/golden-kata:assemble'] });
  });

  it('stubs the procedure Run by default', async () => {
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    expect(read(`${ROOT}/agents/writer/agent/contract.ts`)).toContain(
      'Run: oc',
    );
    expect(read(`${ROOT}/agents/writer/agent/procedures.ts`)).toContain(
      "throw new Error('not implemented: writer.Run')",
    );
  });

  it('changes nothing when generated again', async () => {
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    const before = treeFiles(tree);
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    expect(treeFiles(tree)).toEqual(before);
  });

  it("adds a second agent to every artifact spanning the project's agents", async () => {
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    await agentGenerator(tree, { project: 'golden-kata', name: 'grader' });
    expect(targetsOf()).toEqual(
      expect.arrayContaining([
        'lock-writer',
        'image-writer',
        'serve-writer',
        'lock-grader',
        'image-grader',
        'serve-grader',
      ]),
    );
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').targets?.assemble
        ?.dependsOn,
    ).toEqual(['image-writer', 'image-grader']);
    expect(read(`${ROOT}/client.ts`)).toMatchSnapshot('client of two');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/project.ts`),
    ).toMatchSnapshot('project construct of two');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/index.ts`),
    ).toMatchSnapshot('project index of two');
    expect(read(`${CONSTRUCTS}/agentic-projects/index.ts`)).toBe(
      "export * from './golden-kata/index.js';\n",
    );
  });

  it('drops a removed record from the targets, client and construct, leaving its folder', async () => {
    await agentGenerator(tree, { project: 'golden-kata', name: 'writer' });
    await agentGenerator(tree, { project: 'golden-kata', name: 'grader' });
    const project = readProjectConfiguration(tree, '@proj/golden-kata');
    updateProjectConfiguration(tree, '@proj/golden-kata', {
      ...project,
      metadata: {
        ...project.metadata,
        components: project.metadata?.components?.filter(
          (component: { name: string }) => component.name !== 'grader',
        ),
      },
    });
    await syncGenerator(tree);
    expect(targetsOf().filter((name) => name.includes('grader'))).toEqual([]);
    expect(read(`${ROOT}/client.ts`)).not.toContain('grader');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/project.ts`),
    ).not.toContain('Grader');
    expect(
      read(`${CONSTRUCTS}/agentic-projects/golden-kata/index.ts`),
    ).not.toContain('Grader');
    expect(tree.exists(`${ROOT}/agents/grader/agent/contract.ts`)).toBe(true);
  });

  it('refuses an unknown project, writing nothing', async () => {
    const before = treeFiles(tree);
    await expect(
      agentGenerator(tree, { project: 'absent', name: 'writer' }),
    ).rejects.toThrow('no project named absent');
    expect(treeFiles(tree)).toEqual(before);
  });

  it('refuses a project that is not agentic', async () => {
    await expect(
      agentGenerator(tree, { project: 'common-constructs', name: 'writer' }),
    ).rejects.toThrow('@proj/common-constructs is not an agentic project');
  });

  it('refuses an invalid agent or procedure name, writing nothing', async () => {
    const before = treeFiles(tree);
    await expect(
      agentGenerator(tree, { project: 'golden-kata', name: 'Writer' }),
    ).rejects.toThrow('agent name "Writer" must be kebab-case');
    await expect(
      agentGenerator(tree, { project: 'golden-kata', name: 'base' }),
    ).rejects.toThrow('agent name "base" is reserved');
    await expect(
      agentGenerator(tree, {
        project: 'golden-kata',
        name: 'writer',
        procedure: 'write',
      }),
    ).rejects.toThrow('procedure name "write" must be PascalCase');
    expect(treeFiles(tree)).toEqual(before);
  });
});
