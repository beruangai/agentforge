/**
 * The layered tree `DESIGN_OPTIONS.md` §L composes capabilities from: one
 * `.claude/` per image layer, `cwd` at the deepest. Each layer contributes
 * markers whose names carry the layer, so what loaded is read off the
 * session's own listings with no model reasoning.
 *
 *   <root>/home/.claude                                  user (CLAUDE_CONFIG_DIR)
 *   <root>/agentic/.claude                               agentic project
 *   <root>/agentic/agent/.claude                         agent
 *   <root>/agentic/agent/procedures/discovery/.claude    procedure  <- cwd
 *
 * The tree lives under the OS temporary directory, so no ancestor is this
 * repository and its `.git` cannot cut the walk short.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CAPABILITY_LAYER_NAMES = [
  'user',
  'agenticProject',
  'agent',
  'procedure',
] as const;
export type CapabilityLayerName = (typeof CAPABILITY_LAYER_NAMES)[number];

export type CapabilityLayerPresence = Record<CapabilityLayerName, boolean>;

/** Every layer always carries a `commands/marker-<layer>.md` slash command. */
export type CapabilityMarkerKinds = {
  /**
   * A skill, a subagent and a `settings.json` whose `SessionStart` hook
   * touches `<hookMarkerDirectory>/hook-<layer>`, at every layer.
   */
  skillsSubagentsAndHooks: boolean;
};

export type CapabilityLayerTree = {
  root: string;
  /** The user layer's `.claude/`, passed as `CLAUDE_CONFIG_DIR`. */
  configDirectory: string;
  /** The procedure layer's directory: the deepest, and the session's `cwd`. */
  workingDirectory: string;
  layerDirectories: Record<CapabilityLayerName, string>;
  hookMarkerDirectory: string;
  /** Plants a `.git` directory beside the named layer's `.claude/`. */
  plantRepositoryAt(layer: Exclude<CapabilityLayerName, 'user'>): void;
  /** A directory outside the chain whose `.claude/` carries one command, `marker-mounted`. */
  createMountedDirectory(): string;
  dispose(): void;
};

/** The marker token for a layer, lower-cased as the spikes named them. */
export function markerToken(layer: CapabilityLayerName): string {
  return layer.toLowerCase();
}

export function createCapabilityLayerTree(
  name: string,
  kinds: CapabilityMarkerKinds,
): CapabilityLayerTree {
  const root = mkdtempSync(join(tmpdir(), `agentforge-${name}-`));
  const workingDirectory = join(
    root,
    'agentic',
    'agent',
    'procedures',
    'discovery',
  );
  const layerHomes: Record<CapabilityLayerName, string> = {
    user: join(root, 'home'),
    agenticProject: join(root, 'agentic'),
    agent: join(root, 'agentic', 'agent'),
    procedure: workingDirectory,
  };
  const layerDirectories = Object.fromEntries(
    CAPABILITY_LAYER_NAMES.map((layer) => [
      layer,
      join(layerHomes[layer], '.claude'),
    ]),
  ) as Record<CapabilityLayerName, string>;
  const hookMarkerDirectory = join(root, 'marks');

  mkdirSync(hookMarkerDirectory, { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  for (const layer of CAPABILITY_LAYER_NAMES) {
    const directory = layerDirectories[layer];
    const token = markerToken(layer);
    mkdirSync(join(directory, 'commands'), { recursive: true });
    writeFileSync(
      join(directory, 'commands', `marker-${token}.md`),
      `---\ndescription: marker contributed by the ${layer} layer\n---\n\nSay "${layer}".\n`,
    );
    if (!kinds.skillsSubagentsAndHooks) continue;
    mkdirSync(join(directory, 'skills', `skill-${token}`), { recursive: true });
    mkdirSync(join(directory, 'agents'), { recursive: true });
    writeFileSync(
      join(directory, 'skills', `skill-${token}`, 'SKILL.md'),
      `---\nname: skill-${token}\ndescription: marker skill from the ${layer} layer\n---\n\nSay ${layer}.\n`,
    );
    writeFileSync(
      join(directory, 'agents', `agent-${token}.md`),
      `---\nname: agent-${token}\ndescription: marker subagent from ${layer}\n---\n\nSay ${layer}.\n`,
    );
    // A SessionStart hook that leaves a file behind — the probe for whether
    // settings.json and hooks fall back to parent directories at all.
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `touch ${join(hookMarkerDirectory, `hook-${token}`)}`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  }

  return {
    root,
    configDirectory: layerDirectories.user,
    workingDirectory,
    layerDirectories,
    hookMarkerDirectory,
    plantRepositoryAt(layer) {
      const repository = join(layerHomes[layer], '.git');
      mkdirSync(repository, { recursive: true });
      writeFileSync(join(repository, 'HEAD'), 'ref: refs/heads/main\n');
    },
    createMountedDirectory() {
      const mounted = join(root, 'mnt', 'workdir', 'vault');
      mkdirSync(join(mounted, '.claude', 'commands'), { recursive: true });
      writeFileSync(
        join(mounted, '.claude', 'commands', 'marker-mounted.md'),
        '---\ndescription: marker contributed by a MOUNTED additional directory\n---\n\nSay "mounted".\n',
      );
      return mounted;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Which layers a listing contains, by EXACT name. A substring test reads
 * 'agent' inside 'agenticproject' and reports a layer that never loaded — the
 * bug the first run of the l2 spike had.
 */
export function layersPresent(
  names: readonly string[],
  prefix: 'marker-' | 'skill-' | 'agent-' | 'hook-',
): CapabilityLayerPresence {
  const nameSet = new Set(names);
  return Object.fromEntries(
    CAPABILITY_LAYER_NAMES.map((layer) => [
      layer,
      nameSet.has(`${prefix}${markerToken(layer)}`),
    ]),
  ) as CapabilityLayerPresence;
}

/** The names of the hook marker files the `SessionStart` hooks left behind. */
export function hookMarkersWritten(tree: CapabilityLayerTree): string[] {
  if (!existsSync(tree.hookMarkerDirectory)) {
    throw new Error(
      `hook marker directory ${tree.hookMarkerDirectory} does not exist`,
    );
  }
  return readdirSync(tree.hookMarkerDirectory);
}
