import type { TargetConfiguration } from '@nx/devkit';
import type { AgenticProject } from '../project-record.ts';

const EXECUTOR = '@beruangai/agentforge';

/** Whether a target is one AgentForge renders for an agent, `lock-<agent>`, `image-<agent>` or `serve-<agent>`. */
export function isAgentTarget(
  name: string,
  target: TargetConfiguration,
): boolean {
  return (
    /^(lock|image|serve)-.+$/.test(name) &&
    name !== 'image-agentforge' &&
    target.executor?.startsWith(`${EXECUTOR}:`) === true
  );
}

/**
 * The project's build targets, each image `FROM` the one its target depends
 * on. `^bundle` is a no-op for an installed AgentForge; in AgentForge's own
 * repository it builds the package the container inputs come from. Locks are
 * cached on the manifests and locks they read — an installed AgentForge's
 * version is hashed as the executor's package — and images never are.
 */
export function projectTargets(
  project: AgenticProject,
): Record<string, TargetConfiguration> {
  const dependencyManifests = [
    { dependentTasksOutputFiles: '**/package.json', transitive: true },
    { dependentTasksOutputFiles: '**/bun.lock', transitive: true },
    { runtime: 'bun --version' },
  ];
  const targets: Record<string, TargetConfiguration> = {
    'image-agentforge': {
      executor: `${EXECUTOR}:image`,
      cache: false,
      dependsOn: ['^bundle'],
      options: { layer: 'agentforge' },
    },
    lock: {
      executor: `${EXECUTOR}:lock`,
      cache: true,
      dependsOn: ['^bundle'],
      inputs: [
        '{projectRoot}/base/agentic/package.json',
        ...dependencyManifests,
      ],
      outputs: ['{projectRoot}/base/agentic/bun.lock'],
      options: { layer: 'base' },
    },
    image: {
      executor: `${EXECUTOR}:image`,
      cache: false,
      dependsOn: ['lock', 'image-agentforge'],
      options: { layer: 'base' },
    },
  };
  for (const agent of project.agents) {
    const agentRoot = `{projectRoot}/agents/${agent.name}/agent`;
    targets[`lock-${agent.name}`] = {
      executor: `${EXECUTOR}:lock`,
      cache: true,
      dependsOn: ['lock'],
      inputs: [
        '{projectRoot}/base/agentic/package.json',
        `${agentRoot}/package.json`,
        ...dependencyManifests,
      ],
      outputs: [`${agentRoot}/bun.lock`],
      options: { layer: `agents/${agent.name}` },
    };
    targets[`image-${agent.name}`] = {
      executor: `${EXECUTOR}:image`,
      cache: false,
      dependsOn: [`lock-${agent.name}`, 'image'],
      options: { layer: `agents/${agent.name}` },
    };
    // The serve configuration loads .env.serve.local, where the
    // subscription token lives, never in the target.
    targets[`serve-${agent.name}`] = {
      executor: `${EXECUTOR}:serve`,
      continuous: true,
      dependsOn: [`image-${agent.name}`],
      // In the key order Nx writes targets in, so a sync that changes
      // nothing rewrites nothing.
      defaultConfiguration: 'serve',
      options: { agent: agent.name },
      configurations: { serve: {} },
    };
  }
  targets.assemble = {
    executor: 'nx:noop',
    dependsOn: project.agents.map((agent) => `image-${agent.name}`),
  };
  return targets;
}
