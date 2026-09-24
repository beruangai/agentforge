/**
 * §L / §REQ203 — WHICH kinds of configuration compose up the tree, and where
 * each one stops. The first spike used slash commands as its only marker and
 * generalised the result to everything; the documentation says the three kinds
 * follow three different rules:
 *
 *   settings.json + hooks   <cwd>/.claude/ ONLY, no parent fallback
 *   CLAUDE.md + rules       <cwd> and every parent
 *   skills/commands/agents  <cwd> and every parent UP TO THE REPOSITORY ROOT
 *
 * That distinction decides the layout. If per-layer PERMISSIONS cannot come
 * from the filesystem layers, an image layer cannot grant itself tool access,
 * and per-procedure scoping has to come from the SDK's inline `settings`.
 *
 * Probes, each needing no model reasoning:
 *   - hooks — a SessionStart hook at each level writes a marker file
 *   - skills/commands/subagents — the session's own listings say what loaded
 *   - the repository boundary — the same, with a .git planted mid-tree
 *
 * CLAUDE.md and rules are not probed: a session's start does not list them, so
 * the note takes the documented rule as read rather than confirmed.
 *
 * No model call: the session is read at its start and closed before any turn
 * (see `readSessionStartWithoutATurn`), with no credential in its environment.
 * The spike read `system/init`'s `slash_commands`, `skills` and `agents`; that
 * message is only emitted at the start of a turn, so this reads the
 * `initialize` control response instead — `commands` (skills are listed there
 * as commands, told apart by their `skill-` marker name) and `agents`.
 *
 * Findings: docs/research/capability-composition.md.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapabilityLayerPresence,
  createCapabilityLayerTree,
  hookMarkersWritten,
  layersPresent,
} from '../../__fixtures__/capability-layers.ts';
import {
  createEnvironmentWithoutCredentials,
  QueryRecording,
  readSessionStartWithoutATurn,
} from '../../__fixtures__/claude-agent-sdk.ts';

type ExpectedComposition = {
  /** Skills, commands and subagents follow the same rule. */
  skillsCommandsAndSubagents: CapabilityLayerPresence;
  hooks: CapabilityLayerPresence;
};

type Scenario = {
  name: string;
  plantRepositoryAtAgent: boolean;
  options: Partial<Options>;
  expected: ExpectedComposition;
};

/** settings.json and hooks: `<cwd>/.claude/` and the user scope only. */
const hooksFromCwdAndUserOnly: CapabilityLayerPresence = {
  user: true,
  agenticProject: false,
  agent: false,
  procedure: true,
};

const scenarios: Scenario[] = [
  {
    name: 'no-repository-anywhere',
    plantRepositoryAtAgent: false,
    options: {},
    expected: {
      skillsCommandsAndSubagents: {
        user: true,
        agenticProject: true,
        agent: true,
        procedure: true,
      },
      hooks: hooksFromCwdAndUserOnly,
    },
  },
  {
    // Load-bearing: an agent image may well contain a git repository, and a
    // repository root halts discovery for every layer ABOVE it — silently. The
    // agentic-project layer drops out of skills, commands and subagents — and
    // nothing else changes.
    name: 'repository-at-agent-level',
    plantRepositoryAtAgent: true,
    options: {},
    expected: {
      skillsCommandsAndSubagents: {
        user: true,
        agenticProject: false,
        agent: true,
        procedure: true,
      },
      hooks: hooksFromCwdAndUserOnly,
    },
  },
  {
    // Discovered skills are listed without it; it makes no difference.
    name: 'skills-all',
    plantRepositoryAtAgent: false,
    options: { skills: 'all' },
    expected: {
      skillsCommandsAndSubagents: {
        user: true,
        agenticProject: true,
        agent: true,
        procedure: true,
      },
      hooks: hooksFromCwdAndUserOnly,
    },
  },
];

describe('which kinds of configuration compose, and where each stops', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const tree = createCapabilityLayerTree(`what-composes-${scenario.name}`, {
      skillsSubagentsAndHooks: true,
    });
    onTestFinished(() => tree.dispose());
    if (scenario.plantRepositoryAtAgent) tree.plantRepositoryAt('agent');

    const recording = new QueryRecording(
      'capability-composition',
      `what-composes-${scenario.name}`,
    );
    const { initializationResult, sessionStartHookResponses } =
      await readSessionStartWithoutATurn(
        {
          cwd: tree.workingDirectory,
          settingSources: ['user', 'project'],
          env: createEnvironmentWithoutCredentials(tree.configDirectory),
          ...scenario.options,
        },
        recording,
        true,
      );
    expect(
      initializationResult.account.tokenSource,
      'the probe must start with no credential, so no model request is possible',
    ).toBe('none');

    const commandNames = initializationResult.commands.map(
      (command) => command.name,
    );
    const agentNames = initializationResult.agents.map((agent) => agent.name);
    const hookMarkers = hookMarkersWritten(tree);

    expect(
      layersPresent(commandNames, 'marker-'),
      `commands seen: ${JSON.stringify(commandNames)}`,
    ).toEqual(scenario.expected.skillsCommandsAndSubagents);
    expect(
      layersPresent(commandNames, 'skill-'),
      `skills seen (as commands): ${JSON.stringify(commandNames)}`,
    ).toEqual(scenario.expected.skillsCommandsAndSubagents);
    expect(
      layersPresent(agentNames, 'agent-'),
      `subagents seen: ${JSON.stringify(agentNames)}`,
    ).toEqual(scenario.expected.skillsCommandsAndSubagents);
    expect(
      layersPresent(hookMarkers, 'hook-'),
      `settings.json and hooks load from <cwd>/.claude/ and the user scope only, with no parent fallback; hook markers written: ${JSON.stringify(hookMarkers)}`,
    ).toEqual(scenario.expected.hooks);
    expect(
      sessionStartHookResponses,
      `one SessionStart hook_response per marker written; see ${recording.logPath}`,
    ).toHaveLength(hookMarkers.length);
  });
});
