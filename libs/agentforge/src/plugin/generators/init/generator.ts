import { formatFilesInSubtree } from '@aws/nx-plugin/sdk/utils/format';
import {
  type GeneratorCallback,
  installPackagesTask,
  readNxJson,
  type TargetConfiguration,
  type Tree,
  updateNxJson,
} from '@nx/devkit';
import { declareAgenticProjectDependencies } from '../../workspace-dependencies.ts';

export const SYNC_GENERATOR = '@beruangai/agentforge:sync';
/** The executors whose tasks run the sync generator first. */
const SYNCED_EXECUTORS = [
  '@beruangai/agentforge:lock',
  '@beruangai/agentforge:image',
] as const;

type TargetDefault = Partial<TargetConfiguration> & {
  syncGenerators?: string[];
};

/** A target default with the sync generator last, once. */
function withSync(value: TargetDefault | undefined): TargetDefault {
  const base = value ?? {};
  return {
    ...base,
    syncGenerators: [
      ...(base.syncGenerators ?? []).filter(
        (generator) => generator !== SYNC_GENERATOR,
      ),
      SYNC_GENERATOR,
    ],
  };
}

/**
 * What `nx add @beruangai/agentforge` runs: declares the dependencies an
 * agentic project needs at AgentForge's peer ranges, and attaches the sync
 * generator to the plugin's lock and image tasks, so a stale project is
 * brought current before one runs and `nx sync:check` fails while it is not.
 */
export default async function initGenerator(
  tree: Tree,
): Promise<GeneratorCallback> {
  await declareAgenticProjectDependencies(tree);
  const nxJson = readNxJson(tree);
  if (nxJson === null) throw new Error('the workspace has no nx.json');
  const targetDefaults = { ...nxJson.targetDefaults } as Record<
    string,
    TargetDefault
  >;
  const synced = Object.fromEntries(
    SYNCED_EXECUTORS.map((executor) => [
      executor,
      withSync(targetDefaults[executor]),
    ]),
  );
  if (
    SYNCED_EXECUTORS.some(
      (executor) =>
        JSON.stringify(targetDefaults[executor]) !==
        JSON.stringify(synced[executor]),
    )
  ) {
    updateNxJson(tree, {
      ...nxJson,
      targetDefaults: { ...targetDefaults, ...synced },
    });
  }
  await formatFilesInSubtree(tree);
  return () => installPackagesTask(tree);
}
