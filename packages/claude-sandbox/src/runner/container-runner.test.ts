import { PassThrough } from 'node:stream';

import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerRuntime } from './container-runtime.js';
import {
  runContainer,
  type ContainerRunnerConfig,
} from './container-runner.js';
import { END_SENTINEL, START_SENTINEL } from './sentinel.js';
import type {
  AgentForgeContainerInput,
  AgentForgeContainerOutput,
} from './types.js';

function createMockRuntime(): {
  [K in keyof ContainerRuntime]: Mock;
} {
  return {
    createContainer: vi.fn().mockResolvedValue('container-id-123'),
    startContainer: vi.fn().mockResolvedValue(undefined),
    attachContainer: vi.fn().mockResolvedValue({ stream: new PassThrough() }),
    waitContainer: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    inspectContainer: vi.fn(),
    getContainerLogs: vi.fn(),
    imageExists: vi.fn(),
    inspectImage: vi.fn(),
    buildImage: vi.fn(),
    cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSentinelOutput(output: AgentForgeContainerOutput): string {
  return `${START_SENTINEL}\n${JSON.stringify(output)}\n${END_SENTINEL}\n`;
}

describe('runContainer', () => {
  let runtime: ReturnType<typeof createMockRuntime>;
  let config: ContainerRunnerConfig;
  const baseInput: AgentForgeContainerInput = {
    name: 'test-task',
    prompt: 'Do something',
    model: 'sonnet',
  };

  beforeEach(() => {
    runtime = createMockRuntime();
    config = {
      runtime: runtime as unknown as ContainerRuntime,
      image: 'agentforge-claude:latest',
      cleanupOnExit: true,
      defaultTimeout: 30000,
    };
  });

  it('creates, starts, and cleans up container', async () => {
    const expectedOutput: AgentForgeContainerOutput = {
      status: 'success',
      structuredOutput: { result: 'done' },
    };
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput(expectedOutput),
      stderr: '',
    });

    const result = await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: [],
      env: [],
      timeout: 30000,
    });

    expect(runtime.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'agentforge-claude:latest',
        name: 'test-container',
        openStdin: true,
      }),
    );
    expect(runtime.startContainer).toHaveBeenCalledWith('container-id-123');
    expect(runtime.waitContainer).toHaveBeenCalledWith(
      'container-id-123',
      30000,
    );
    expect(runtime.removeContainer).toHaveBeenCalledWith(
      'container-id-123',
      true,
    );
    expect(result.output).toEqual(expectedOutput);
    expect(result.statusCode).toBe(0);
  });

  it('passes environment variables and binds', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput({ status: 'success' }),
      stderr: '',
    });

    await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: ['/host/data:/workspace/data', '/host/ctx:/workspace/ctx:ro'],
      env: ['ANTHROPIC_API_KEY=sk-test', 'CUSTOM_VAR=value'],
      timeout: 30000,
    });

    expect(runtime.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        env: ['ANTHROPIC_API_KEY=sk-test', 'CUSTOM_VAR=value'],
        binds: ['/host/data:/workspace/data', '/host/ctx:/workspace/ctx:ro'],
      }),
    );
  });

  it('uses default extra hosts when none specified', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput({ status: 'success' }),
      stderr: '',
    });

    await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: [],
      env: [],
      timeout: 30000,
    });

    expect(runtime.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        extraHosts: ['host.docker.internal:host-gateway'],
      }),
    );
  });

  it('throws when sentinel output is missing', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: 'no sentinel markers here',
      stderr: 'some error',
    });

    await expect(
      runContainer(config, {
        name: 'test-container',
        input: baseInput,
        binds: [],
        env: [],
        timeout: 30000,
      }),
    ).rejects.toThrow('Sentinel output not found');
  });

  it('throws with stderr content when sentinel missing', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: '',
      stderr: 'Error: module not found',
    });

    await expect(
      runContainer(config, {
        name: 'test-container',
        input: baseInput,
        binds: [],
        env: [],
        timeout: 30000,
      }),
    ).rejects.toThrow('Error: module not found');
  });

  it('still cleans up container on error', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: 'crash',
      stderr: '',
    });

    await expect(
      runContainer(config, {
        name: 'test-container',
        input: baseInput,
        binds: [],
        env: [],
        timeout: 30000,
      }),
    ).rejects.toThrow();

    expect(runtime.removeContainer).toHaveBeenCalledWith(
      'container-id-123',
      true,
    );
  });

  it('does not cleanup when cleanupOnExit is false', async () => {
    config.cleanupOnExit = false;
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput({ status: 'success' }),
      stderr: '',
    });

    await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: [],
      env: [],
      timeout: 30000,
    });

    expect(runtime.removeContainer).not.toHaveBeenCalled();
  });

  it('passes network and custom extra hosts', async () => {
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput({ status: 'success' }),
      stderr: '',
    });

    await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: [],
      env: [],
      timeout: 30000,
      network: 'agentforge-net',
      extraHosts: ['custom-host:192.168.1.1'],
    });

    expect(runtime.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'agentforge-net',
        extraHosts: ['custom-host:192.168.1.1'],
      }),
    );
  });

  it('writes input as JSON to stdin stream', async () => {
    const stream = new PassThrough();
    const writtenChunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => writtenChunks.push(chunk));

    runtime.attachContainer.mockResolvedValue({ stream });
    runtime.getContainerLogs.mockResolvedValue({
      stdout: makeSentinelOutput({ status: 'success' }),
      stderr: '',
    });

    await runContainer(config, {
      name: 'test-container',
      input: baseInput,
      binds: [],
      env: [],
      timeout: 30000,
    });

    const written = Buffer.concat(writtenChunks).toString('utf-8');
    expect(JSON.parse(written)).toEqual(baseInput);
  });
});
