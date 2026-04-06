import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { resolveCredentialEnv } from '../credentials/credential-config.js';
import {
  containerName,
  taskIdentityHash,
} from '../identity/container-identity.js';
import { sessionMountPath } from '../identity/sessions.js';
import { ImageManager } from '../image/image-manager.js';
import { generateEnvShadowMounts } from '../volumes/env-shadow.js';
import { resolveVolumes } from '../volumes/volume-resolver.js';
import { ContainerRuntime } from './container-runtime.js';
import { runContainer } from './container-runner.js';
import type {
  AgentForgeContainerOutput,
  ExecuteConfig,
  SandboxRunnerConfig,
} from './types.js';

const DEFAULT_IMAGE = 'agentforge-claude:latest';
const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_SESSIONS_DIR = './data/sessions';

export class SandboxRunner {
  private readonly config: Required<
    Pick<
      SandboxRunnerConfig,
      'image' | 'defaultTimeout' | 'cleanupOnExit' | 'sessionsDir'
    >
  > &
    SandboxRunnerConfig;
  private readonly runtime: ContainerRuntime;
  private readonly imageManager: ImageManager;

  constructor(config: SandboxRunnerConfig = {}) {
    this.config = {
      ...config,
      image: config.image ?? DEFAULT_IMAGE,
      defaultTimeout: config.defaultTimeout ?? DEFAULT_TIMEOUT,
      cleanupOnExit: config.cleanupOnExit ?? true,
      sessionsDir: config.sessionsDir ?? DEFAULT_SESSIONS_DIR,
    };
    this.runtime = new ContainerRuntime();
    this.imageManager = new ImageManager(this.runtime);
  }

  async execute(
    executeConfig: ExecuteConfig,
  ): Promise<AgentForgeContainerOutput> {
    const timeout = executeConfig.timeout ?? this.config.defaultTimeout;

    // Ensure Docker image exists and is up to date (auto-builds on first use)
    await this.imageManager.ensureImage({
      image: this.config.image,
      dockerfile: this.config.dockerfile,
    });

    // Stable identity for session directory keying (same config = same session mount)
    const identityHash = taskIdentityHash(
      executeConfig.input.name,
      this.config.image,
      executeConfig.volumes,
    );

    // Unique container name per execution (prevents Docker name collision)
    const executionId = randomUUID().slice(0, 8);
    const name = containerName(executeConfig.input.name, executionId);

    // Set up session mount keyed by stable identity
    const sessionsDir = resolve(this.config.sessionsDir);
    const sessionDir = sessionMountPath(sessionsDir, identityHash);

    const env = this.buildEnv(executeConfig);
    const binds = resolveVolumes(executeConfig.volumes);

    // Shadow .env files in mounted volumes to prevent secret leaks
    const envShadows = generateEnvShadowMounts(binds);
    binds.push(...envShadows);

    // 3-tier settings hierarchy:
    // 1. Global (user scope): /home/agent/.claude — session persistence + shared capabilities
    binds.push(`${sessionDir}:/home/agent/.claude`);
    // 2. Archetype (project scope parent): /workspace/.claude — preset capabilities
    //    Mounted by consumer via volumes if needed (e.g., '/host/archetype/.claude': '/workspace/.claude')
    // 3. Task (project scope): /workspace/task/.claude — task-specific capabilities
    //    Mounted by consumer via volumes if needed, or created by the agent at runtime

    const result = await runContainer(
      {
        runtime: this.runtime,
        image: this.config.image,
        cleanupOnExit: this.config.cleanupOnExit,
        defaultTimeout: timeout,
      },
      {
        name,
        input: executeConfig.input,
        binds,
        env,
        timeout,
        network: executeConfig.network,
        extraHosts: executeConfig.extraHosts,
      },
    );

    return result.output;
  }

  /**
   * Clean up orphaned containers with the agentforge- prefix.
   * Call on runner shutdown or on-demand.
   */
  async cleanup(): Promise<void> {
    await this.runtime.cleanupOrphans('agentforge-');
  }

  private buildEnv(config: ExecuteConfig): string[] {
    const env: string[] = [];

    // Inject credential env vars
    const credEnv = resolveCredentialEnv(this.config.credentials, config.env);
    for (const [key, value] of Object.entries(credEnv)) {
      env.push(`${key}=${value}`);
    }

    // Add user-provided env vars (can override credential vars)
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        env.push(`${key}=${value}`);
      }
    }

    return env;
  }
}
