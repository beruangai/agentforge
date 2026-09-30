// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TemporalWorker,
  type TemporalWorkerProps,
  type WorkerSecrets,
} from '@beruangai/agentforge/infra';
import type { REQUIRED_SECRETS as PROJECT_SECRETS } from '@beruangai/golden-kata-workflows/secrets';
import type { Construct } from 'constructs';
import { RuntimeConfig } from '../../../core/runtime-config.js';
import { findWorkspaceRoot } from '../../../core/workspace.js';
import { AgenticProject as GoldenKata } from '../../agentic-projects/golden-kata/project.js';

const WORKSPACE_ROOT = findWorkspaceRoot(fileURLToPath(import.meta.url));
/** The worker's image build context: the project's `bundle` output. */
const BUNDLE_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/packages/examples/golden-kata-workflows/bundle',
);

function bundleDirectory(): string {
  if (!existsSync(join(BUNDLE_DIRECTORY, 'worker.mjs'))) {
    throw new Error(
      `${BUNDLE_DIRECTORY}/worker.mjs is missing: bundle the worker first, with nx run @beruangai/golden-kata-workflows:bundle`,
    );
  }
  return BUNDLE_DIRECTORY;
}

/**
 * The worker's secrets, by the environment variable each becomes: the
 * Temporal Cloud API key, and the project's `REQUIRED_SECRETS`.
 */
export type Secrets = WorkerSecrets<(typeof PROJECT_SECRETS)[number]>;

export type WorkflowProjectProps = Omit<
  TemporalWorkerProps,
  'directory' | 'secrets' | 'agents'
> & {
  readonly secrets: Secrets;
  /** Each connected agentic project's construct: the worker may invoke its agents. */
  readonly agenticProjects: {
    readonly goldenKata: GoldenKata;
  };
};

/**
 * golden-kata-workflows's worker on ECS, polling its task queue on Temporal Cloud,
 * granted invocation of exactly its connected projects' agents.
 */
export class WorkflowProject extends TemporalWorker {
  constructor(scope: Construct, id: string, props: WorkflowProjectProps) {
    const { agenticProjects, ...worker } = props;
    super(scope, id, {
      ...worker,
      directory: bundleDirectory(),
      agents: `runtime-config:${RuntimeConfig.ensure(scope).appConfigApplicationId}`,
    });
    agenticProjects.goldenKata.grantInvoke(this);
  }
}
