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
  appendConnectionComponent,
  CONNECTION_GENERATOR,
  connectedProjects,
  connectionComponent,
  readAgenticProject,
  readAgenticProjects,
  readWorkflowProject,
  WORKFLOW_PROJECT_GENERATOR,
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

describe('a workflow project', () => {
  const GOLDEN_KATA_CONNECTION = {
    generator: CONNECTION_GENERATOR,
    name: 'golden-kata',
    path: '../golden-kata',
    packageName: '@proj/golden-kata',
    key: 'goldenKata',
  } as const;

  function addWorkflowProject(metadata: Record<string, unknown>): void {
    addProjectConfiguration(tree, '@proj/golden-kata-workflows', {
      root: 'packages/golden-kata-workflows',
      metadata,
      targets: {},
    });
    writeJson(tree, 'packages/golden-kata-workflows/package.json', {
      name: '@proj/golden-kata-workflows',
    });
  }

  const RECORD = {
    generator: WORKFLOW_PROJECT_GENERATOR,
    components: [GOLDEN_KATA_CONNECTION],
    agentforge: { detached: { files: [], targets: [] } },
  };

  it('reads a valid record', () => {
    addWorkflowProject(RECORD);
    expect(readWorkflowProject(tree, 'golden-kata-workflows')).toEqual({
      name: '@proj/golden-kata-workflows',
      root: 'packages/golden-kata-workflows',
      packageName: '@proj/golden-kata-workflows',
      projectName: 'golden-kata-workflows',
      scope: 'proj',
      connections: [GOLDEN_KATA_CONNECTION],
      detached: { files: [], targets: [] },
    });
  });

  it('refuses an invalid record, naming the component', () => {
    addWorkflowProject({
      ...RECORD,
      components: [{ ...GOLDEN_KATA_CONNECTION, key: 'GoldenKata' }],
    });
    expect(() => readWorkflowProject(tree, 'golden-kata-workflows')).toThrow(
      `@proj/golden-kata-workflows's component "golden-kata" is not a connection's record`,
    );
  });

  it('refuses an agentic project as a workflow project', () => {
    addProject({
      generator: AGENTIC_PROJECT_GENERATOR,
      components: [],
      agentforge: { detached: { files: [], targets: [] } },
    });
    expect(() => readWorkflowProject(tree, 'golden-kata')).toThrow(
      '@proj/golden-kata is not a workflow project',
    );
  });

  it("resolves a connection's agentic project by package name", () => {
    addWorkflowProject(RECORD);
    addProject({
      generator: AGENTIC_PROJECT_GENERATOR,
      components: [WRITER],
      agentforge: { detached: { files: [], targets: [] } },
    });
    const [connected] = connectedProjects(
      readWorkflowProject(tree, 'golden-kata-workflows'),
      readAgenticProjects(tree),
    );
    expect(connected?.agenticProject.root).toBe('packages/golden-kata');
    expect(connected?.connection).toEqual(GOLDEN_KATA_CONNECTION);
  });

  it('fails a connection whose project is gone, naming it', () => {
    addWorkflowProject(RECORD);
    expect(() =>
      connectedProjects(
        readWorkflowProject(tree, 'golden-kata-workflows'),
        readAgenticProjects(tree),
      ),
    ).toThrow(
      '@proj/golden-kata-workflows records a connection to @proj/golden-kata, which is not an agentic project in the workspace',
    );
  });

  it('records a connection once', () => {
    addWorkflowProject({ ...RECORD, components: [] });
    const component = connectionComponent(
      { root: 'packages/golden-kata-workflows' },
      {
        root: 'packages/golden-kata',
        packageName: '@proj/golden-kata',
        projectName: 'golden-kata',
      },
    );
    expect(component).toEqual(GOLDEN_KATA_CONNECTION);
    appendConnectionComponent(tree, 'golden-kata-workflows', component);
    appendConnectionComponent(tree, 'golden-kata-workflows', component);
    expect(
      readProjectConfiguration(tree, '@proj/golden-kata-workflows').metadata
        ?.components,
    ).toEqual([GOLDEN_KATA_CONNECTION]);
  });
});
