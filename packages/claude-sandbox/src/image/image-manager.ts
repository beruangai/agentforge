import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContainerRuntime } from '../runner/container-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DOCKERFILE = resolve(__dirname, '../docker/Dockerfile.base');

const LABEL_HASH = 'org.agentforge.dockerfile-hash';
const LABEL_TIMESTAMP = 'org.agentforge.build-timestamp';
const DRIFT_WARNING_DAYS = 7;

export class ImageManager {
  private readonly runtime: ContainerRuntime;
  private buildPromise: Promise<void> | null = null;

  constructor(runtime: ContainerRuntime) {
    this.runtime = runtime;
  }

  /**
   * Ensure the image exists and is up to date.
   * Builds from the Dockerfile if:
   * - The image doesn't exist locally
   * - The Dockerfile content hash has changed
   *
   * Uses a singleton promise so concurrent calls don't trigger duplicate builds.
   */
  async ensureImage(config: {
    image: string;
    dockerfile?: string;
  }): Promise<void> {
    const dockerfilePath = config.dockerfile ?? BUNDLED_DOCKERFILE;
    const content = readFileSync(dockerfilePath, 'utf-8');
    const contentHash = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);

    const exists = await this.runtime.imageExists(config.image);

    if (exists) {
      // Check if the image was built from the same Dockerfile content
      const matchesHash = await this.imageMatchesHash(
        config.image,
        contentHash,
      );
      if (matchesHash) {
        await this.checkBuildAge(config.image);
        return;
      }
    }

    // Build (or reuse in-flight build)
    if (!this.buildPromise) {
      this.buildPromise = this.build(
        dockerfilePath,
        config.image,
        contentHash,
      ).finally(() => {
        this.buildPromise = null;
      });
    }

    await this.buildPromise;
  }

  private async build(
    dockerfilePath: string,
    tag: string,
    contentHash: string,
  ): Promise<void> {
    const contextDir = dirname(dockerfilePath);
    const filename = dockerfilePath.split('/').pop()!;
    await this.runtime.buildImage(contextDir, filename, tag, {
      [LABEL_HASH]: contentHash,
      [LABEL_TIMESTAMP]: Date.now().toString(),
    });
  }

  private async imageMatchesHash(
    imageName: string,
    expectedHash: string,
  ): Promise<boolean> {
    try {
      const info = await this.runtime.inspectImage(imageName);
      const labels = info.Config?.Labels ?? {};
      return labels[LABEL_HASH] === expectedHash;
    } catch {
      return false;
    }
  }

  /**
   * Warn if the image was built more than DRIFT_WARNING_DAYS ago.
   * SDK packages use "latest" with no lockfile, so old images may have
   * drifted from the globally installed claude-code version.
   */
  private async checkBuildAge(imageName: string): Promise<void> {
    try {
      const info = await this.runtime.inspectImage(imageName);
      const labels = info.Config?.Labels ?? {};
      const timestamp = labels[LABEL_TIMESTAMP];
      if (!timestamp) return;

      const buildTime = parseInt(timestamp, 10);
      if (isNaN(buildTime)) return;

      const ageMs = Date.now() - buildTime;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays > DRIFT_WARNING_DAYS) {
        console.warn(
          `[agentforge] Image "${imageName}" was built ${Math.floor(ageDays)} days ago. ` +
            `SDK versions may have drifted. Consider rebuilding: ` +
            `docker rmi ${imageName} && re-run to trigger fresh build.`,
        );
      }
    } catch {
      // Non-fatal — skip drift check if inspect fails
    }
  }
}
