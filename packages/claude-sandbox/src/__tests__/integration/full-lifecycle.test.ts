/**
 * Integration tests for the full container lifecycle.
 * These tests require Docker to be running and will create/destroy real containers.
 *
 * Run with: INTEGRATION=true bunx vitest run --config packages/claude-sandbox/vitest.config.mts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContainerRuntime } from '../../runner/container-runtime.js';

const SKIP = !process.env['INTEGRATION'];
const TEST_IMAGE = 'agentforge-integration-test:latest';

// Simple test image that reads stdin and echoes it with sentinels.
// Uses node:22-slim as base since it has bash and is lightweight.
const TEST_DOCKERFILE = `
FROM node:22-slim
RUN useradd -m -s /bin/bash agent || true
USER agent
WORKDIR /workspace
COPY entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["bash", "/app/entrypoint.sh"]
`;

const TEST_ENTRYPOINT = `#!/bin/bash
INPUT=$(cat)
echo "---AGENTFORGE_OUTPUT_START---"
echo "{\\"status\\":\\"success\\",\\"structuredOutput\\":{\\"echo\\":\\"received\\"}}"
echo "---AGENTFORGE_OUTPUT_END---"
`;

describe.skipIf(SKIP)('Integration: Full Lifecycle', () => {
  let runtime: ContainerRuntime;
  let buildDir: string;

  beforeAll(async () => {
    runtime = new ContainerRuntime();
    buildDir = join(tmpdir(), `agentforge-integ-${Date.now()}`);
    mkdirSync(buildDir, { recursive: true });

    // Write test Dockerfile and entrypoint
    writeFileSync(join(buildDir, 'Dockerfile'), TEST_DOCKERFILE);
    writeFileSync(join(buildDir, 'entrypoint.sh'), TEST_ENTRYPOINT);

    // Build test image
    await runtime.buildImage(buildDir, 'Dockerfile', TEST_IMAGE);
  }, 120_000);

  afterAll(async () => {
    rmSync(buildDir, { recursive: true, force: true });
    // Cleanup any lingering test containers
    await runtime.cleanupOrphans('agentforge-test-');
  });

  it('creates, runs, and cleans up a container', async () => {
    const containerId = await runtime.createContainer({
      image: TEST_IMAGE,
      name: `agentforge-test-lifecycle-${Date.now()}`,
      env: [],
      binds: [],
      extraHosts: ['host.docker.internal:host-gateway'],
      openStdin: true,
    });

    try {
      const { stream } = await runtime.attachContainer(containerId);
      await runtime.startContainer(containerId);

      stream.write('{"name":"test","prompt":"hello"}');
      stream.end();

      const result = await runtime.waitContainer(containerId, 30_000);
      expect(result.StatusCode).toBe(0);

      const { stdout } = await runtime.getContainerLogs(containerId);
      expect(stdout).toContain('AGENTFORGE_OUTPUT_START');
      expect(stdout).toContain('"success"');
    } finally {
      await runtime.removeContainer(containerId, true);
    }
  }, 60_000);

  it('handles container timeout by killing container', async () => {
    // Use a container that sleeps forever — our timeout should kill it
    const sleepDockerfile = `
FROM node:22-slim
ENTRYPOINT ["sleep", "300"]
`;
    const sleepDir = join(tmpdir(), `agentforge-sleep-${Date.now()}`);
    mkdirSync(sleepDir, { recursive: true });
    writeFileSync(join(sleepDir, 'Dockerfile'), sleepDockerfile);

    const sleepImage = `agentforge-sleep-test:${Date.now()}`;
    await runtime.buildImage(sleepDir, 'Dockerfile', sleepImage);

    const containerId = await runtime.createContainer({
      image: sleepImage,
      name: `agentforge-test-timeout-${Date.now()}`,
      env: [],
      binds: [],
      extraHosts: [],
      openStdin: false,
    });

    try {
      await runtime.startContainer(containerId);

      // The timeout should kill the container and reject
      // Docker may return StatusCode 137 (SIGKILL) before our timeout fires,
      // or our timeout fires first and kills it. Either way, it shouldn't hang.
      const startTime = Date.now();
      try {
        const result = await runtime.waitContainer(containerId, 3_000);
        // If it resolved, the container was killed (137 = SIGKILL)
        expect(result.StatusCode).toBe(137);
      } catch (err) {
        // If it rejected, our timeout fired first
        expect((err as Error).message).toContain('timed out');
      }
      // Verify it completed quickly (within timeout + buffer)
      expect(Date.now() - startTime).toBeLessThan(10_000);
    } finally {
      await runtime.removeContainer(containerId, true);
      rmSync(sleepDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('mounts volumes correctly', async () => {
    const volumeDir = join(tmpdir(), `agentforge-vol-${Date.now()}`);
    mkdirSync(volumeDir, { recursive: true });
    writeFileSync(join(volumeDir, 'test.txt'), 'hello from host');

    const containerId = await runtime.createContainer({
      image: TEST_IMAGE,
      name: `agentforge-test-volumes-${Date.now()}`,
      env: [],
      binds: [`${volumeDir}:/workspace/data:ro`],
      extraHosts: [],
      openStdin: true,
    });

    try {
      const { stream } = await runtime.attachContainer(containerId);
      await runtime.startContainer(containerId);
      stream.write('{}');
      stream.end();

      await runtime.waitContainer(containerId, 30_000);
      // If we got here without error, the mount was accepted by Docker
    } finally {
      await runtime.removeContainer(containerId, true);
      rmSync(volumeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('passes environment variables to container', async () => {
    const containerId = await runtime.createContainer({
      image: TEST_IMAGE,
      name: `agentforge-test-env-${Date.now()}`,
      env: ['TEST_VAR=hello_world', 'ANOTHER=value'],
      binds: [],
      extraHosts: [],
      openStdin: true,
    });

    try {
      const { stream } = await runtime.attachContainer(containerId);
      await runtime.startContainer(containerId);
      stream.write('{}');
      stream.end();

      await runtime.waitContainer(containerId, 30_000);
      const info = await runtime.inspectContainer(containerId);
      expect(info.Config.Env).toEqual(
        expect.arrayContaining(['TEST_VAR=hello_world', 'ANOTHER=value']),
      );
    } finally {
      await runtime.removeContainer(containerId, true);
    }
  }, 60_000);

  it('sets up host.docker.internal extra host', async () => {
    const containerId = await runtime.createContainer({
      image: TEST_IMAGE,
      name: `agentforge-test-host-${Date.now()}`,
      env: [],
      binds: [],
      extraHosts: ['host.docker.internal:host-gateway'],
      openStdin: true,
    });

    try {
      const info = await runtime.inspectContainer(containerId);
      expect(info.HostConfig.ExtraHosts).toContain(
        'host.docker.internal:host-gateway',
      );
    } finally {
      await runtime.removeContainer(containerId, true);
    }
  }, 30_000);

  it('propagates error output via sentinels', async () => {
    // Test that non-zero exit + sentinel still works
    const errorDockerfile = `
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["bash", "/app/entrypoint.sh"]
`;
    const errorEntrypoint = `#!/bin/bash
echo "---AGENTFORGE_OUTPUT_START---"
echo "{\\"status\\":\\"error\\",\\"error\\":\\"task failed\\"}"
echo "---AGENTFORGE_OUTPUT_END---"
exit 1
`;
    const errorDir = join(tmpdir(), `agentforge-error-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });
    writeFileSync(join(errorDir, 'Dockerfile'), errorDockerfile);
    writeFileSync(join(errorDir, 'entrypoint.sh'), errorEntrypoint);

    const errorImage = `agentforge-error-test:${Date.now()}`;
    await runtime.buildImage(errorDir, 'Dockerfile', errorImage);

    const containerId = await runtime.createContainer({
      image: errorImage,
      name: `agentforge-test-error-${Date.now()}`,
      env: [],
      binds: [],
      extraHosts: [],
      openStdin: false,
    });

    try {
      await runtime.startContainer(containerId);
      const result = await runtime.waitContainer(containerId, 30_000);
      expect(result.StatusCode).toBe(1);

      const { stdout } = await runtime.getContainerLogs(containerId);
      expect(stdout).toContain('AGENTFORGE_OUTPUT_START');
      expect(stdout).toContain('"error"');
      expect(stdout).toContain('task failed');
    } finally {
      await runtime.removeContainer(containerId, true);
      rmSync(errorDir, { recursive: true, force: true });
    }
  }, 60_000);
});
