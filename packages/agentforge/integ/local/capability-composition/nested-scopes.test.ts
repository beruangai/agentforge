/**
 * §L / §REQ203 — does the Agent SDK compose capabilities from NESTED
 * directories above `cwd`, or only from one project root?
 *
 * This is load-bearing. The layered design contributes one `.claude/` per image
 * layer — base image, agentic project, agent, and optionally procedure — with
 * `cwd` set at the deepest. That only works if project-scope discovery walks UP
 * from `cwd`.
 *
 * The documentation contradicted itself on exactly this point when the spike
 * was written (read 2026-09-22): the TypeScript SDK reference says project
 * settings are "discovered upward from cwd"; the .claude directory reference
 * says Claude Code "does NOT walk up parent directories". So it is measured,
 * not read. Each level contributes a uniquely named slash command, and the
 * session's own listing says which loaded.
 *
 * No model call: the session is read at its start and closed before any turn
 * (see `readSessionStartWithoutATurn`), with no credential in its environment.
 * The spike read `system/init.slash_commands`; that message is only emitted at
 * the start of a turn, so this reads the same listing from the `initialize`
 * control response's `commands`.
 *
 * `['user','project']` with no repository, and with a `.git` at the agent
 * level, are asserted in `what-composes.test.ts`, which probes every kind of
 * marker under those settings.
 *
 * Findings: docs/research/capability-composition.md (the settingSources table
 * is in the note's first version, commit 17949bc).
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapabilityLayerPresence,
  type CapabilityLayerTree,
  createCapabilityLayerTree,
  layersPresent,
} from '../../__fixtures__/capability-layers.ts';
import {
  createEnvironmentWithoutCredentials,
  QueryRecording,
  readSessionStartWithoutATurn,
} from '../../__fixtures__/claude-agent-sdk.ts';

const everyLayer: CapabilityLayerPresence = {
  user: true,
  agenticProject: true,
  agent: true,
  procedure: true,
};

function createTree(testName: string): CapabilityLayerTree {
  const tree = createCapabilityLayerTree(`nested-scopes-${testName}`, {
    skillsSubagentsAndHooks: false,
  });
  onTestFinished(() => tree.dispose());
  return tree;
}

/** The command names the session discovered, read without a turn. */
async function discoveredCommandNames(
  testName: string,
  tree: CapabilityLayerTree,
  options: Partial<Options>,
): Promise<string[]> {
  const recording = new QueryRecording(
    'capability-composition',
    `nested-scopes-${testName}`,
  );
  const { initializationResult } = await readSessionStartWithoutATurn(
    {
      cwd: tree.workingDirectory,
      env: createEnvironmentWithoutCredentials(tree.configDirectory),
      ...options,
    },
    recording,
    false,
  );
  expect(
    initializationResult.account.tokenSource,
    'the probe must start with no credential, so no model request is possible',
  ).toBe('none');
  return initializationResult.commands.map((command) => command.name);
}

describe('nested .claude directories above cwd compose', () => {
  it("settingSources ['project'] drops only the user layer", async () => {
    const tree = createTree('project-only');
    const names = await discoveredCommandNames('project-only', tree, {
      settingSources: ['project'],
    });
    expect(
      layersPresent(names, 'marker-'),
      `['project'] excludes the user layer and keeps every nested level; commands seen: ${JSON.stringify(names)}`,
    ).toEqual({ ...everyLayer, user: false });
  });

  it('settingSources omitted (the default) loads every layer', async () => {
    const tree = createTree('default-sources');
    const names = await discoveredCommandNames('default-sources', tree, {});
    expect(
      layersPresent(names, 'marker-'),
      `commands seen: ${JSON.stringify(names)}`,
    ).toEqual(everyLayer);
  });

  it('additionalDirectories contributes its commands, not only read access', async () => {
    // With the `project` source enabled the SDK loads an additional
    // directory's skills, commands and subagents: a mounted directory can
    // inject capabilities, not merely be readable.
    const tree = createTree('additional-directory');
    const mountedDirectory = tree.createMountedDirectory();
    const names = await discoveredCommandNames('additional-directory', tree, {
      settingSources: ['user', 'project'],
      additionalDirectories: [mountedDirectory],
    });
    expect(
      names,
      'a directory passed as additionalDirectories contributes its .claude/commands',
    ).toContain('marker-mounted');
  });
});
