/**
 * Layered image builds are reproducible, and a change moves exactly the images
 * above it — DESIGN_OPTIONS §D, findings in docs/research/image-determinism.md.
 *
 * A three-level tree, as ARCHITECTURE §6 lays it out: AgentForge's base, one
 * agentic base `FROM` it, three agents `FROM` that. Measured on the manifest
 * digests a registry serves:
 *
 *   - an unchanged rebuild is byte-identical, all five images;
 *   - a change to one agent moves that agent and nothing else;
 *   - a change to the agentic base moves all three agents and not the base;
 *   - of the reproducibility switches, `SOURCE_DATE_EPOCH` AND
 *     `rewrite-timestamp=true` are both load-bearing. The epoch alone
 *     normalises the config's `created` field and leaves file mtimes in the
 *     layer tarballs, so it looks reproducible in its configuration and is not.
 *     That case is also the control that shows the comparisons here can fail.
 *
 * WHY THIS IS KEPT, and what it is not. Nothing in AgentForge depends on these
 * digests: Nx's affected graph decides what is rebuilt and therefore deployed,
 * an unaffected agent is never rebuilt, and AgentForge builds no digest
 * comparison of its own. Reproducibility is kept because an image that rebuilds
 * identically from identical inputs is easier to audit and to trust, and the
 * requirements are cheap once known. The answer depends on BuildKit, buildx and
 * the base image, all of which move, so it is re-measured rather than assumed.
 *
 * Three buildx facts shape the setup (see `__fixtures__/buildx-environment.ts`):
 * the `docker` driver cannot export OCI at all; the `docker` exporter does not
 * rewrite layer timestamps, so its image id moves on every build and is no
 * change signal — the manifest digest in `--metadata-file` is; and a
 * `docker-container` builder cannot see daemon images, which is why a registry
 * sits between the levels here. None of the three constrains the real build
 * chain, which runs on the ordinary driver against daemon images because it
 * does not need `rewrite-timestamp` — only a measurement of reproducibility does.
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pinnedBunBaseImage,
  pinnedBunBaseImageReference,
} from '../../__fixtures__/pinned-base-image.ts';
import { runCommand } from '../../__fixtures__/run-command.ts';
import {
  type BuildxEnvironment,
  buildAndReadManifestDigest,
  createBuildxEnvironment,
  removeBuildxEnvironment,
} from './__fixtures__/buildx-environment.ts';

/** A fixed epoch removes build time from the image config. Necessary; not sufficient. */
const sourceDateEpoch = '1700000000';
const imageTreeFixture = join(
  import.meta.dirname,
  '__fixtures__',
  'image-tree',
);
const buildTimeoutMilliseconds = 600_000;

interface ImageTreeDigests {
  readonly base: string;
  readonly agenticBase: string;
  readonly agentA: string;
  readonly agentB: string;
  readonly agentC: string;
}

describe('layered image builds', () => {
  let buildxEnvironment: BuildxEnvironment | undefined;

  beforeAll(async () => {
    buildxEnvironment = await createBuildxEnvironment();
  }, buildTimeoutMilliseconds);

  afterAll(async () => {
    if (buildxEnvironment !== undefined) {
      await removeBuildxEnvironment(buildxEnvironment);
    }
  }, buildTimeoutMilliseconds);

  function requireEnvironment(): BuildxEnvironment {
    if (buildxEnvironment === undefined) {
      throw new Error('The buildx environment was not created; see beforeAll');
    }
    return buildxEnvironment;
  }

  /** A private copy of the tree, so a test can change it without touching the fixture. */
  async function copyImageTree(): Promise<string> {
    const treeDirectory = await mkdtemp(
      join(requireEnvironment().scratchDirectory, 'image-tree-'),
    );
    await cp(imageTreeFixture, treeDirectory, { recursive: true });
    return treeDirectory;
  }

  /**
   * Builds the whole tree reproducibly. Each level pins its parent BY DIGEST,
   * which ARCHITECTURE §6 requires of the external base; here it also makes
   * "the base did not move" mean "nothing above it needed to".
   */
  async function buildImageTree(
    treeDirectory: string,
  ): Promise<ImageTreeDigests> {
    const environment = requireEnvironment();
    const build = (
      level: string,
      repository: string,
      buildArguments: Record<string, string>,
    ) =>
      buildAndReadManifestDigest(environment, {
        contextDirectory: join(treeDirectory, level),
        repository,
        buildArguments,
        sourceDateEpoch,
        rewriteTimestamp: true,
        noCache: false,
      });
    const registry = environment.registryAddress;
    const base = await build('base', 'agentforge/a2a-claude', {
      BUN_IMAGE: pinnedBunBaseImageReference,
    });
    const agenticBase = await build('agentic-base', 'integ/project', {
      BASE_IMAGE: `${registry}/agentforge/a2a-claude@${base}`,
    });
    const agenticBaseImage = `${registry}/integ/project@${agenticBase}`;
    const agentA = await build('agent-a', 'integ/project/a', {
      AGENTIC_BASE_IMAGE: agenticBaseImage,
    });
    const agentB = await build('agent-b', 'integ/project/b', {
      AGENTIC_BASE_IMAGE: agenticBaseImage,
    });
    const agentC = await build('agent-c', 'integ/project/c', {
      AGENTIC_BASE_IMAGE: agenticBaseImage,
    });
    return { base, agenticBase, agentA, agentB, agentC };
  }

  it('the pinned external base still resolves, byte for byte, to its digest', async () => {
    const { stdout } = await runCommand(
      'docker',
      ['buildx', 'imagetools', 'inspect', '--raw', pinnedBunBaseImageReference],
      {
        purpose: `Resolving ${pinnedBunBaseImageReference}`,
        environment: requireEnvironment().environment,
      },
    );
    const servedDigest = `sha256:${createHash('sha256').update(stdout, 'utf8').digest('hex')}`;
    expect(servedDigest).toBe(pinnedBunBaseImage.indexDigest);
    const index = JSON.parse(stdout) as {
      manifests: { platform?: { os: string; architecture: string } }[];
    };
    expect(index.manifests.map((manifest) => manifest.platform)).toContainEqual(
      { os: 'linux', architecture: 'arm64' },
    );
  });

  it(
    'an unchanged rebuild is byte-identical on every manifest digest',
    async () => {
      const treeDirectory = await copyImageTree();
      const first = await buildImageTree(treeDirectory);
      const rebuild = await buildImageTree(treeDirectory);
      expect(rebuild).toEqual(first);
    },
    buildTimeoutMilliseconds,
  );

  it(
    "a change to one agent moves that agent's image and no other",
    async () => {
      const treeDirectory = await copyImageTree();
      const before = await buildImageTree(treeDirectory);
      await writeFile(
        join(treeDirectory, 'agent-a', 'procedures', 'procedure.ts'),
        "export const procedure = 'procedure for agent a, v2';\n",
      );
      const after = await buildImageTree(treeDirectory);
      expect(after.agentA).not.toBe(before.agentA);
      expect({
        base: after.base,
        agenticBase: after.agenticBase,
        agentB: after.agentB,
        agentC: after.agentC,
      }).toEqual({
        base: before.base,
        agenticBase: before.agenticBase,
        agentB: before.agentB,
        agentC: before.agentC,
      });
    },
    buildTimeoutMilliseconds,
  );

  it(
    'a change to the agentic base moves every agent above it and not the base below',
    async () => {
      const treeDirectory = await copyImageTree();
      const before = await buildImageTree(treeDirectory);
      await writeFile(
        join(treeDirectory, 'agentic-base', 'capabilities', 'shared-skill.md'),
        'shared capability v2\n',
      );
      const after = await buildImageTree(treeDirectory);
      expect(after.base).toBe(before.base);
      expect(after.agenticBase).not.toBe(before.agenticBase);
      expect(after.agentA).not.toBe(before.agentA);
      expect(after.agentB).not.toBe(before.agentB);
      expect(after.agentC).not.toBe(before.agentC);
    },
    buildTimeoutMilliseconds,
  );

  /**
   * Two `--no-cache` builds of the base, two seconds apart so anything read
   * from the clock differs, under each combination of switches.
   */
  it(
    'only SOURCE_DATE_EPOCH with rewrite-timestamp is reproducible; the epoch alone is not',
    async () => {
      const environment = requireEnvironment();
      const treeDirectory = await copyImageTree();
      const buildTwice = async (switches: {
        sourceDateEpoch: string | undefined;
        rewriteTimestamp: boolean;
      }) => {
        const build = () =>
          buildAndReadManifestDigest(environment, {
            contextDirectory: join(treeDirectory, 'base'),
            repository: 'agentforge/probe',
            buildArguments: { BUN_IMAGE: pinnedBunBaseImageReference },
            noCache: true,
            ...switches,
          });
        const first = await build();
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return [first, await build()] as const;
      };

      const epochAndRewrite = await buildTwice({
        sourceDateEpoch,
        rewriteTimestamp: true,
      });
      const epochOnly = await buildTwice({
        sourceDateEpoch,
        rewriteTimestamp: false,
      });
      const neither = await buildTwice({
        sourceDateEpoch: undefined,
        rewriteTimestamp: false,
      });

      expect(epochAndRewrite[1]).toBe(epochAndRewrite[0]);
      expect(epochOnly[1]).not.toBe(epochOnly[0]);
      expect(neither[1]).not.toBe(neither[0]);
    },
    buildTimeoutMilliseconds,
  );
});
