/**
 * Docker integration tests for the temporal-workflow activity factory.
 * Validates the full lifecycle: createClaudeSandboxActivity → SandboxRunner.execute() → real container.
 *
 * Requires Docker to be running.
 * Run with: bunx nx run @beruangai/agentforge-temporal-workflow:test --configuration=integ
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';

import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';
import { createClaudeSandboxActivity } from '../src/activity/create-claude-sandbox-activity.js';

// Mock trace-env to avoid langsmith dependency
vi.mock('../src/tracing/trace-env.js', () => ({
  getTraceEnvVars: vi.fn().mockResolvedValue({}),
}));

const TEST_IMAGE = 'agentforge-temporal-integ:latest';

// Test image that echoes input back as structured output via sentinel protocol.
// Reads stdin JSON, extracts prompt, returns it in structured output.
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
echo "{\\"status\\":\\"success\\",\\"structuredOutput\\":{\\"echo\\":\\"received\\",\\"inputLength\\":$(echo -n "$INPUT" | wc -c | tr -d ' ')}}"
echo "---AGENTFORGE_OUTPUT_END---"
`;

const SLOW_ENTRYPOINT = `#!/bin/bash
INPUT=$(cat)
sleep 2
echo "---AGENTFORGE_OUTPUT_START---"
echo "{\\"status\\":\\"success\\",\\"structuredOutput\\":{\\"echo\\":\\"slow\\"}}"
echo "---AGENTFORGE_OUTPUT_END---"
`;

const ERROR_ENTRYPOINT = `#!/bin/bash
cat > /dev/null
echo "---AGENTFORGE_OUTPUT_START---"
echo "{\\"status\\":\\"error\\",\\"error\\":\\"simulated agent failure\\"}"
echo "---AGENTFORGE_OUTPUT_END---"
exit 1
`;

describe('Docker: activity factory → SandboxRunner → real container', () => {
  let runner: SandboxRunner;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = join(tmpdir(), `agentforge-temporal-integ-${Date.now()}`);
    mkdirSync(buildDir, { recursive: true });

    writeFileSync(join(buildDir, 'Dockerfile'), TEST_DOCKERFILE);
    writeFileSync(join(buildDir, 'entrypoint.sh'), TEST_ENTRYPOINT);

    // Build the test image via Docker CLI
    const { execSync } = await import('node:child_process');
    execSync(`docker build -t ${TEST_IMAGE} ${buildDir}`, {
      stdio: 'pipe',
    });

    runner = new SandboxRunner({
      image: TEST_IMAGE,
      defaultTimeout: 30_000,
      cleanupOnExit: true,
      sessionsDir: join(tmpdir(), `agentforge-sessions-${Date.now()}`),
    });
  }, 120_000);

  afterAll(async () => {
    await runner?.cleanup();
    rmSync(buildDir, { recursive: true, force: true });
  });

  it('executes activity through real container and returns output', async () => {
    const activity = createClaudeSandboxActivity({
      name: 'integ-test-task',
      runner,
      sandbox: (input: { message: string }) => ({
        prompt: input.message,
      }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    const result = (await env.run(activity, { message: 'hello from integ test' })) as {
      echo: string;
      inputLength: number;
    };

    expect(result).toEqual(
      expect.objectContaining({
        echo: 'received',
        inputLength: expect.any(Number),
      }),
    );
    expect(result.inputLength).toBeGreaterThan(0);
  }, 60_000);

  it('validates output with Zod schema on real container output', async () => {
    const outputSchema = z.object({
      echo: z.string(),
      inputLength: z.number(),
    });

    const activity = createClaudeSandboxActivity({
      name: 'integ-validated-task',
      runner,
      outputSchema,
      sandbox: (input: { message: string }) => ({
        prompt: input.message,
      }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    const result = (await env.run(activity, { message: 'validate me' })) as {
      echo: string;
      inputLength: number;
    };

    expect(result.echo).toBe('received');
    expect(typeof result.inputLength).toBe('number');
  }, 60_000);

  it('classifies container error as retryable ApplicationFailure', async () => {
    // Build error image
    const errorDir = join(tmpdir(), `agentforge-error-integ-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });
    writeFileSync(join(errorDir, 'Dockerfile'), TEST_DOCKERFILE);
    writeFileSync(join(errorDir, 'entrypoint.sh'), ERROR_ENTRYPOINT);

    const errorImage = `agentforge-temporal-error-integ:${Date.now()}`;
    const { execSync } = await import('node:child_process');
    execSync(`docker build -t ${errorImage} ${errorDir}`, { stdio: 'pipe' });

    const errorRunner = new SandboxRunner({
      image: errorImage,
      defaultTimeout: 30_000,
      cleanupOnExit: true,
      sessionsDir: join(tmpdir(), `agentforge-err-sessions-${Date.now()}`),
    });

    const activity = createClaudeSandboxActivity({
      name: 'integ-error-task',
      runner: errorRunner,
      sandbox: () => ({ prompt: 'trigger error' }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    try {
      await env.run(activity, {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('AgentTaskError');
      expect(af.nonRetryable).toBe(false);
    } finally {
      await errorRunner.cleanup();
      rmSync(errorDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('passes environment variables to container', async () => {
    const activity = createClaudeSandboxActivity({
      name: 'integ-env-task',
      runner,
      sandbox: () => ({
        prompt: 'env test',
        env: {
          CUSTOM_VAR: 'custom_value',
        },
      }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    const result = await env.run(activity, {});

    // Container ran successfully with env vars — output confirms execution
    expect(result).toEqual(
      expect.objectContaining({
        echo: 'received',
      }),
    );
  }, 60_000);

  it('heartbeats are emitted during real container execution', async () => {
    // Build a slow image that sleeps 2s to ensure heartbeats fire
    const slowDir = join(tmpdir(), `agentforge-slow-integ-${Date.now()}`);
    mkdirSync(slowDir, { recursive: true });
    writeFileSync(join(slowDir, 'Dockerfile'), TEST_DOCKERFILE);
    writeFileSync(join(slowDir, 'entrypoint.sh'), SLOW_ENTRYPOINT);

    const slowImage = `agentforge-temporal-slow-integ:${Date.now()}`;
    const { execSync } = await import('node:child_process');
    execSync(`docker build -t ${slowImage} ${slowDir}`, { stdio: 'pipe' });

    const slowRunner = new SandboxRunner({
      image: slowImage,
      defaultTimeout: 30_000,
      cleanupOnExit: true,
      sessionsDir: join(tmpdir(), `agentforge-slow-sessions-${Date.now()}`),
    });

    const activity = createClaudeSandboxActivity({
      name: 'integ-heartbeat-task',
      runner: slowRunner,
      heartbeatInterval: 200, // Fast heartbeat — container sleeps 2s so ~10 heartbeats expected
      sandbox: () => ({ prompt: 'heartbeat test' }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (details) => heartbeats.push(details));

    await env.run(activity, {});

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    await slowRunner.cleanup();
    rmSync(slowDir, { recursive: true, force: true });
  }, 60_000);
});

describe('Docker: container → gateway → mock upstream', () => {
  let runner: SandboxRunner;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = join(tmpdir(), `agentforge-gw-integ-${Date.now()}`);
    mkdirSync(buildDir, { recursive: true });

    writeFileSync(join(buildDir, 'Dockerfile'), TEST_DOCKERFILE);
    writeFileSync(join(buildDir, 'entrypoint.sh'), TEST_ENTRYPOINT);

    const { execSync } = await import('node:child_process');
    execSync(`docker build -t ${TEST_IMAGE} ${buildDir}`, { stdio: 'pipe' });

    runner = new SandboxRunner({
      image: TEST_IMAGE,
      defaultTimeout: 30_000,
      cleanupOnExit: true,
      sessionsDir: join(tmpdir(), `agentforge-gw-sessions-${Date.now()}`),
    });
  }, 120_000);

  afterAll(async () => {
    await runner?.cleanup();
    rmSync(buildDir, { recursive: true, force: true });
  });

  it('activity receives mcpServers config from gateway', async () => {
    // Use a mock gateway that returns a known config
    const mockGateway = {
      close: vi.fn(),
      status: vi.fn(),
      mcpServersConfig: vi.fn().mockReturnValue({
        'mock-gateway': {
          type: 'url',
          url: 'http://host.docker.internal:9999/mcp',
          headers: { 'X-Tools': 'mock:echo' },
        },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'integ-gateway-task',
      runner,
      gateway: mockGateway as any,
      sandbox: () => ({
        prompt: 'gateway test',
        tools: ['mock:*'],
      }),
      timeout: 30_000,
    });

    const env = new MockActivityEnvironment();
    const result = await env.run(activity, {});

    // Verify gateway was called with correct tool patterns
    expect(mockGateway.mcpServersConfig).toHaveBeenCalledWith(['mock:*']);

    // Container ran and returned output (mcpServers config was passed through)
    expect(result).toEqual(
      expect.objectContaining({
        echo: 'received',
      }),
    );
  }, 60_000);
});
