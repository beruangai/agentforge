import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import { describe, expect, it } from 'vitest';
import { projectTargets } from '../../artifacts/targets.ts';
import { workflowProjectTargets } from '../../artifacts/workflow-project.ts';
import {
  AGENTIC_PROJECT_GENERATOR,
  type AgenticProject,
  WORKFLOW_PROJECT_GENERATOR,
} from '../../project-record.ts';
import {
  checkEveryTaskSees,
  defaultLocation,
  effectiveDeclaration,
  sameRemote,
  seedRepository,
  serveTasks,
  withDeclaration,
} from './executor.ts';

const SAME = (left: string, right: string) => left === right;

describe('sameRemote', () => {
  it('compares two spellings of one remote, and no other', () => {
    expect(
      sameRemote('https://github.com/o/r.git', 'https://github.com/o/r/'),
    ).toBe(true);
    expect(
      sameRemote('https://github.com/o/r.git', 'https://github.com/o/s.git'),
    ).toBe(false);
  });
});

describe('withDeclaration', () => {
  it('adds the variable to a file without it, keeping its lines', () => {
    expect(withDeclaration('A=1\n', '.env.serve', 'vault', 'v.git', SAME)).toBe(
      'A=1\nAGENTFORGE_FILESYSTEM_REPOSITORIES={"vault":"v.git"}\n',
    );
    expect(withDeclaration('', '.env.serve', 'vault', 'v.git', SAME)).toBe(
      'AGENTFORGE_FILESYSTEM_REPOSITORIES={"vault":"v.git"}\n',
    );
  });

  it("merges the entry into the variable's line, and changes nothing when it is there", () => {
    const content =
      'A=1\nAGENTFORGE_FILESYSTEM_REPOSITORIES={"notes":"n.git"}\nB=2\n';
    const merged = withDeclaration(
      content,
      '.env.serve',
      'vault',
      'v.git',
      SAME,
    );
    expect(merged).toBe(
      'A=1\nAGENTFORGE_FILESYSTEM_REPOSITORIES={"notes":"n.git","vault":"v.git"}\nB=2\n',
    );
    expect(withDeclaration(merged, '.env.serve', 'vault', 'v.git', SAME)).toBe(
      merged,
    );
  });

  it('refuses an entry naming another location, and a variable defined twice', () => {
    expect(() =>
      withDeclaration(
        'AGENTFORGE_FILESYSTEM_REPOSITORIES={"vault":"old.git"}\n',
        '.env.serve',
        'vault',
        'v.git',
        SAME,
      ),
    ).toThrow(
      /\.env\.serve declares repository "vault" at old\.git, not v\.git/,
    );
    expect(() =>
      withDeclaration(
        'AGENTFORGE_FILESYSTEM_REPOSITORIES={}\nAGENTFORGE_FILESYSTEM_REPOSITORIES={}\n',
        '.env.serve',
        'vault',
        'v.git',
        SAME,
      ),
    ).toThrow(/defines AGENTFORGE_FILESYSTEM_REPOSITORIES 2 times/);
  });
});

describe('effectiveDeclaration', () => {
  const files: Record<string, string> = {
    '.env.serve': 'AGENTFORGE_FILESYSTEM_REPOSITORIES={"vault":"v.git"}\n',
    'apps/rnd/.env.serve':
      'AGENTFORGE_FILESYSTEM_REPOSITORIES={"notes":"n.git"}\n',
    'apps/rnd/.env': 'A=1\n',
  };
  const contents = (file: string) => files[file];

  it("is the project's own definition first, then the workspace's", () => {
    expect(
      effectiveDeclaration(
        {
          project: 'rnd',
          projectRoot: 'apps/rnd',
          target: 'serve-writer',
          configuration: 'serve',
        },
        contents,
      ),
    ).toEqual({
      file: 'apps/rnd/.env.serve',
      value: '{"notes":"n.git"}',
    });
    expect(
      effectiveDeclaration(
        {
          project: 'flows',
          projectRoot: 'apps/flows',
          target: 'serve',
          configuration: 'local',
        },
        contents,
      ),
    ).toEqual({ file: '.env.serve', value: '{"vault":"v.git"}' });
  });
});

describe('serveTasks', () => {
  it("is every agentic project's serve executor and a workflow project's serve, in each configuration it runs under", () => {
    const context = {
      projectsConfigurations: {
        version: 2,
        projects: {
          rnd: {
            root: 'apps/rnd',
            metadata: { generator: AGENTIC_PROJECT_GENERATOR },
            targets: {
              'serve-writer': {
                executor: '@beruangai/agentforge:serve',
                defaultConfiguration: 'serve',
                configurations: { serve: {} },
              },
              lock: { executor: '@beruangai/agentforge:lock' },
            },
          },
          flows: {
            root: 'apps/flows',
            metadata: { generator: WORKFLOW_PROJECT_GENERATOR },
            targets: {
              serve: {
                executor: 'nx:run-commands',
                configurations: { local: {}, hybrid: {} },
              },
            },
          },
          other: {
            root: 'apps/other',
            targets: { serve: { executor: 'nx:run-commands' } },
          },
        },
      },
    } as unknown as ExecutorContext;
    expect(
      serveTasks(context).map(
        (task) => `${task.project}:${task.target}:${task.configuration}`,
      ),
    ).toEqual([
      'rnd:serve-writer:serve',
      'flows:serve:undefined',
      'flows:serve:local',
      'flows:serve:hybrid',
    ]);
  });
});

describe('checkEveryTaskSees', () => {
  // The serve targets the plugin generates, each with a default configuration.
  const generated = {
    projectsConfigurations: {
      version: 2,
      projects: {
        rnd: {
          root: 'apps/rnd/agentic',
          metadata: { generator: AGENTIC_PROJECT_GENERATOR },
          targets: projectTargets({
            framework: 'claude',
            agents: [{ name: 'loop' }],
          } as unknown as AgenticProject),
        },
        'rnd-workflows': {
          root: 'apps/rnd/worker',
          metadata: { generator: WORKFLOW_PROJECT_GENERATOR },
          targets: workflowProjectTargets(),
        },
      },
    },
  } as unknown as ExecutorContext;

  it.each([
    ['an absolute', '/repositories/strategies.git', '.env.serve.local'],
    [
      'a workspace-relative',
      '.agentforge/repositories/strategies.git',
      '.env.serve',
    ],
  ])(
    "passes every generated serve task %s location declared only in the workspace's file for it",
    (_label, location, file) => {
      const contents = (each: string) =>
        each === file
          ? `AGENTFORGE_FILESYSTEM_REPOSITORIES=${JSON.stringify({ strategies: location })}\n`
          : undefined;
      expect(() =>
        checkEveryTaskSees(
          serveTasks(generated),
          contents,
          'strategies',
          location,
          SAME,
        ),
      ).not.toThrow();
    },
  );
});

describe('seedRepository', () => {
  it('defaults to a location inside the workspace', () => {
    expect(defaultLocation('vault')).toBe('.agentforge/repositories/vault.git');
  });

  it.each([
    [
      'a user name',
      'https://token@github.com/o/vault.git',
      /carries a credential/,
    ],
    [
      'a password',
      'https://x:secret@github.com/o/vault.git',
      /carries a credential/,
    ],
    ['another scheme', 'git@github.com:o/vault.git', /is not a URL/],
    ['ssh', 'ssh://git@github.com/o/vault.git', /must be https:\/\//],
  ])(
    'refuses a remote with %s before writing anything',
    (_label, remote, message) => {
      const workspace = mkdtempSync(join(tmpdir(), 'agentforge-seed-'));
      let error: unknown;
      try {
        seedRepository(
          { repository: 'vault', remote },
          workspace,
          [],
          () => {},
        );
      } catch (thrown) {
        error = thrown;
      }
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain('secret');
      expect(readdirSync(workspace)).toEqual([]);
    },
  );

  it('refuses a repository name a git filesystem could not declare', () => {
    expect(() =>
      seedRepository(
        { repository: 'Vault', remote: 'https://github.com/o/vault.git' },
        '/workspace',
        [],
      ),
    ).toThrow(/repository "Vault" must match/);
  });
});
