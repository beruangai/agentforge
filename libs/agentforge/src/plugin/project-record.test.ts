import { createTreeUsingTsSolutionSetup } from '@aws/nx-plugin/sdk/utils/test';
import {
  addProjectConfiguration,
  readProjectConfiguration,
  type Tree,
  writeJson,
} from '@nx/devkit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_GENERATOR,
  AGENTIC_PROJECT_GENERATOR,
  type AgentComponent,
  agentComponent,
  appendAgentComponent,
  readAgenticProject,
} from './project-record.ts';

let tree: Tree;

function addProject(metadata: Record<string, unknown>): void {
  addProjectConfiguration(tree, '@proj/golden-kata', {
    root: 'packages/golden-kata',
    metadata,
    targets: {},
  });
  writeJson(tree, 'packages/golden-kata/package.json', {
    name: '@proj/golden-kata',
  });
}

const WRITER: AgentComponent = {
  generator: AGENT_GENERATOR,
  name: 'writer',
  path: 'agents/writer',
  runtimeConfigKey: 'GoldenKataWriter',
  containerName: 'proj-golden-kata-writer',
};

beforeEach(() => {
  tree = createTreeUsingTsSolutionSetup();
});

describe('readAgenticProject', () => {
  it('reads a valid record, by the project name without its scope', () => {
    addProject({
      generator: AGENTIC_PROJECT_GENERATOR,
      components: [
        WRITER,
        { generator: 'ts#agent', name: 'other', path: 'src/other' },
      ],
      agentforge: { detached: { files: [], targets: ['image'] } },
    });
    expect(readAgenticProject(tree, 'golden-kata')).toEqual({
      name: '@proj/golden-kata',
      root: 'packages/golden-kata',
      packageName: '@proj/golden-kata',
      projectName: 'golden-kata',
      scope: 'proj',
      agents: [WRITER],
      detached: { files: [], targets: ['image'] },
    });
  });

  it('refuses a project another generator made', () => {
    addProject({ generator: 'ts#project' });
    expect(() => readAgenticProject(tree, 'golden-kata')).toThrow(
      '@proj/golden-kata is not an agentic project',
    );
  });

  it('refuses an invalid record, naming the component', () => {
    addProject({
      generator: AGENTIC_PROJECT_GENERATOR,
      components: [{ ...WRITER, runtimeConfigKey: 'not-pascal' }],
      agentforge: { detached: { files: [], targets: [] } },
    });
    expect(() => readAgenticProject(tree, 'golden-kata')).toThrow(
      `@proj/golden-kata's component "writer" is not an agent's record`,
    );
  });

  it('refuses a record without what the consumer detached', () => {
    addProject({ generator: AGENTIC_PROJECT_GENERATOR, components: [] });
    expect(() => readAgenticProject(tree, 'golden-kata')).toThrow(/agentforge/);
  });

  it('refuses an unknown project', () => {
    expect(() => readAgenticProject(tree, 'absent')).toThrow(
      'no project named absent',
    );
  });
});

describe('appendAgentComponent', () => {
  beforeEach(() => {
    addProject({
      generator: AGENTIC_PROJECT_GENERATOR,
      components: [],
      agentforge: { detached: { files: [], targets: [] } },
    });
  });

  it('assigns the key and container name from the scope, project and agent', () => {
    expect(
      agentComponent({ scope: 'proj', projectName: 'golden-kata' }, 'writer'),
    ).toEqual({ ...WRITER });
  });

  it('appends a record once, deduped by name', () => {
    appendAgentComponent(tree, 'golden-kata', WRITER);
    appendAgentComponent(tree, 'golden-kata', {
      ...WRITER,
      containerName: 'changed',
    });
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata').metadata?.components,
    ).toEqual([WRITER]);
  });

  it('refuses a name another generator recorded', () => {
    addProjectConfiguration(tree, '@proj/other', {
      root: 'packages/other',
      metadata: {
        generator: AGENTIC_PROJECT_GENERATOR,
        components: [{ generator: 'ts#agent', name: 'writer', path: 'src' }],
        agentforge: { detached: { files: [], targets: [] } },
      },
    });
    expect(() => appendAgentComponent(tree, '@proj/other', WRITER)).toThrow(
      '@proj/other already has a component named writer, recorded by ts#agent',
    );
  });
});
