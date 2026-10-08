/**
 * AgentForge as a consumer installs it before it is published: the `pack`
 * target's archive, by absolute path, in a workspace created apart from this
 * repository with `@aws/nx-plugin`'s preset (§REQ709, spec
 * `plugin-agentic-project`). The examples resolve AgentForge from source, so
 * this is the only test of the bundle's compiled plugin and of images built
 * from an installed package.
 *
 * It needs Docker and the network: the preset and the images install from
 * registries. Nx runs without its daemon, which can sync against a stale
 * graph right after a generator (docs/research/package-installation.md).
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../__fixtures__/run-command.ts';

const REPOSITORY_ROOT = join(import.meta.dirname, '../../../../..');
const ARCHIVE = join(
  REPOSITORY_ROOT,
  'dist/libs/agentforge/pack/beruangai-agentforge.tgz',
);
const BUNDLE = join(REPOSITORY_ROOT, 'dist/libs/agentforge/bundle');

const WORKSPACE_NAME = 'consumer';
const AGENTIC_PROJECT = 'kata';
const AGENT = 'writer';
const WORKFLOW_PROJECT = 'kata-workflows';
const IMAGES = [
  `${WORKSPACE_NAME}/${AGENTIC_PROJECT}-${AGENT}:local`,
  `${WORKSPACE_NAME}/${AGENTIC_PROJECT}:local`,
];

const MINUTE = 60_000;

/** The Nx version this workspace pins, which the consumer is created at. */
function pinnedNxVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as { catalog?: Record<string, string> };
  const version = manifest.catalog?.nx;
  if (version === undefined) {
    throw new Error("the root package.json's catalog pins no nx version");
  }
  return version;
}

/**
 * This process's environment without Nx's own variables, which describe the
 * `integ` task running this test, not the consumer's; and Nx's daemon off.
 */
function consumerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('NX_')) environment[name] = value;
  }
  return { ...environment, NX_DAEMON: 'false' };
}

describe('AgentForge installed from its archive, in a workspace of its own', () => {
  let base: string;
  let workspace: string;
  const environment = consumerEnvironment();

  /** Runs `command` in the consumer's workspace. */
  function inWorkspace(purpose: string, command: string, ...args: string[]) {
    return runCommand(command, args, {
      purpose,
      workingDirectory: workspace,
      environment,
    });
  }

  beforeAll(async () => {
    if (!existsSync(ARCHIVE)) {
      throw new Error(
        `${ARCHIVE} is missing: the integ target depends on pack, which writes it`,
      );
    }
    base = mkdtempSync(join(tmpdir(), 'agentforge-package-tarball-'));
    workspace = join(base, WORKSPACE_NAME);
    await runCommand(
      'bunx',
      [
        `create-nx-workspace@${pinnedNxVersion()}`,
        WORKSPACE_NAME,
        '--preset=@aws/nx-plugin',
        '--pm=bun',
        '--nxCloud=skip',
        '--no-interactive',
      ],
      {
        purpose: "creating a workspace with @aws/nx-plugin's preset",
        workingDirectory: base,
        environment,
      },
    );
    await inWorkspace(
      'adding AgentForge from its archive',
      'bunx',
      'nx',
      'add',
      `@beruangai/agentforge@${ARCHIVE}`,
    );
    const generate = (purpose: string, ...args: string[]) =>
      inWorkspace(purpose, 'bunx', 'nx', 'g', ...args, '--no-interactive');
    await generate(
      'generating an agentic project',
      '@beruangai/agentforge:agentic-project',
      AGENTIC_PROJECT,
    );
    await generate(
      'generating an agent',
      '@beruangai/agentforge:agent',
      '--project',
      AGENTIC_PROJECT,
      AGENT,
    );
    await generate(
      'generating a workflow project',
      '@beruangai/agentforge:workflow-project',
      WORKFLOW_PROJECT,
    );
    await generate(
      'connecting the workflow project to the agentic project',
      '@beruangai/agentforge:connection',
      '--project',
      WORKFLOW_PROJECT,
      '--agenticProject',
      AGENTIC_PROJECT,
    );
    await inWorkspace('syncing the workspace', 'bunx', 'nx', 'sync');
  }, 20 * MINUTE);

  afterAll(async () => {
    for (const image of [...IMAGES, 'agentforge/a2a-claude:0.0.0']) {
      const { stdout } = await runCommand(
        'docker',
        ['image', 'ls', '-q', image],
        {
          purpose: `listing ${image}`,
        },
      );
      if (stdout.trim() !== '') {
        await runCommand('docker', ['image', 'rm', image], {
          purpose: `removing ${image}`,
        });
      }
    }
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  }, 5 * MINUTE);

  it('depends on AgentForge by the absolute path in every generated manifest', () => {
    const manifests = [
      'package.json',
      `packages/${AGENTIC_PROJECT}/package.json`,
      `packages/${WORKFLOW_PROJECT}/package.json`,
      'packages/common/constructs/package.json',
    ];
    const specifiers = manifests.map((manifest) => {
      const { dependencies, devDependencies } = JSON.parse(
        readFileSync(join(workspace, manifest), 'utf8'),
      ) as Record<string, Record<string, string> | undefined>;
      return [
        manifest,
        dependencies?.['@beruangai/agentforge'] ??
          devDependencies?.['@beruangai/agentforge'],
      ];
    });
    expect(specifiers).toEqual(
      manifests.map((manifest) => [manifest, ARCHIVE]),
    );
  });

  it("resolves AgentForge's peers from the workspace", async () => {
    const { stdout } = await inWorkspace(
      'resolving zod from inside the installed package',
      'node',
      '--input-type=module',
      '-e',
      "import { createRequire } from 'node:module'; console.log(createRequire(import.meta.resolve('@beruangai/agentforge/package.json')).resolve('zod'));",
    );
    expect(
      realpathSync(stdout.trim()).startsWith(`${realpathSync(workspace)}/`),
    ).toBe(true);
  });

  it(
    'is in sync, and typechecks',
    async () => {
      await inWorkspace('checking sync', 'bunx', 'nx', 'sync:check');
      await inWorkspace(
        'typechecking the workspace',
        'bunx',
        'nx',
        'run-many',
        '-t',
        'typecheck',
      );
    },
    10 * MINUTE,
  );

  it(
    "builds the agent's images from the installed package",
    async () => {
      await inWorkspace(
        "building the agent's images",
        'bunx',
        'nx',
        'run',
        `@${WORKSPACE_NAME}/${AGENTIC_PROJECT}:image-${AGENT}`,
      );
      for (const image of IMAGES) {
        await runCommand('docker', ['image', 'inspect', image], {
          purpose: `inspecting ${image}`,
        });
      }
    },
    15 * MINUTE,
  );

  it(
    "bundles the workflow project's worker",
    async () => {
      await inWorkspace(
        "bundling the workflow project's worker",
        'bunx',
        'nx',
        'run',
        `@${WORKSPACE_NAME}/${WORKFLOW_PROJECT}:bundle`,
      );
      expect(
        existsSync(
          join(
            workspace,
            `dist/packages/${WORKFLOW_PROJECT}/bundle/worker.mjs`,
          ),
        ),
      ).toBe(true);
    },
    10 * MINUTE,
  );

  it(
    'fails to initialise, naming the bundle, when AgentForge is linked rather than installed',
    async () => {
      const installed = join(workspace, 'node_modules/@beruangai/agentforge');
      const setAside = join(base, 'agentforge-installed');
      renameSync(installed, setAside);
      symlinkSync(BUNDLE, installed);
      try {
        await expect(
          inWorkspace(
            'initialising with AgentForge linked',
            'bunx',
            'nx',
            'g',
            '@beruangai/agentforge:init',
          ),
        ).rejects.toThrow(/dist\/libs\/agentforge\/bundle/);
      } finally {
        rmSync(installed);
        renameSync(setAside, installed);
      }
    },
    5 * MINUTE,
  );
});
