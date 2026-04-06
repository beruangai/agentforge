/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';

import {
  ContainerRuntime,
  validateContainerName,
} from './container-runtime.js';

/**
 * Build a Docker multiplexed log frame.
 * Format: [streamType(1) + padding(3) + size(4 BE)] + payload
 * streamType: 1 = stdout, 2 = stderr
 */
function buildLogFrame(streamType: number, data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function createMockDocker() {
  const mockContainer = {
    id: 'mock-container-id',
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const docker = {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
  };

  return { docker, mockContainer };
}

describe('validateContainerName', () => {
  it('accepts valid alphanumeric names', () => {
    expect(() => validateContainerName('mycontainer')).not.toThrow();
    expect(() => validateContainerName('my-container')).not.toThrow();
    expect(() => validateContainerName('my.container')).not.toThrow();
    expect(() => validateContainerName('my_container')).not.toThrow();
    expect(() => validateContainerName('MyContainer123')).not.toThrow();
    expect(() => validateContainerName('A')).not.toThrow();
    expect(() =>
      validateContainerName('container.name-with_all.chars'),
    ).not.toThrow();
  });

  it('rejects names with semicolons (shell injection)', () => {
    expect(() => validateContainerName('foo;rm -rf /')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with $() (command substitution)', () => {
    expect(() => validateContainerName('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with backticks', () => {
    expect(() => validateContainerName('foo`id`')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with spaces', () => {
    expect(() => validateContainerName('foo bar')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects empty string', () => {
    expect(() => validateContainerName('')).toThrow('Invalid container name');
  });

  it('rejects names starting with dot', () => {
    expect(() => validateContainerName('.hidden')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names starting with hyphen', () => {
    expect(() => validateContainerName('-bad')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names starting with underscore', () => {
    expect(() => validateContainerName('_bad')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with pipe characters', () => {
    expect(() => validateContainerName('foo|bar')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with ampersand', () => {
    expect(() => validateContainerName('foo&bar')).toThrow(
      'Invalid container name',
    );
  });
});

describe('ContainerRuntime', () => {
  describe('createContainer', () => {
    it('rejects invalid container names', async () => {
      const { docker } = createMockDocker();
      const runtime = new ContainerRuntime(docker as any);

      await expect(
        runtime.createContainer({
          image: 'test:latest',
          name: 'bad;name',
          env: [],
          binds: [],
          extraHosts: [],
          openStdin: false,
        }),
      ).rejects.toThrow('Invalid container name');

      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('accepts valid container names and creates container', async () => {
      const { docker } = createMockDocker();
      const runtime = new ContainerRuntime(docker as any);

      const id = await runtime.createContainer({
        image: 'test:latest',
        name: 'valid-name',
        env: [],
        binds: [],
        extraHosts: [],
        openStdin: false,
      });

      expect(id).toBe('mock-container-id');
      expect(docker.createContainer).toHaveBeenCalledOnce();
    });
  });

  describe('cleanupOrphans', () => {
    it('handles no containers found', async () => {
      const { docker } = createMockDocker();
      docker.listContainers.mockResolvedValue([]);
      const runtime = new ContainerRuntime(docker as any);

      await expect(
        runtime.cleanupOrphans('agentforge-'),
      ).resolves.toBeUndefined();
      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { name: ['agentforge-'] },
      });
    });

    it('stops and removes found containers', async () => {
      const { docker, mockContainer } = createMockDocker();
      docker.listContainers.mockResolvedValue([
        { Id: 'container-1' },
        { Id: 'container-2' },
      ]);
      const runtime = new ContainerRuntime(docker as any);

      await runtime.cleanupOrphans('agentforge-');

      expect(docker.getContainer).toHaveBeenCalledWith('container-1');
      expect(docker.getContainer).toHaveBeenCalledWith('container-2');
      expect(mockContainer.stop).toHaveBeenCalledTimes(2);
      expect(mockContainer.remove).toHaveBeenCalledTimes(2);
    });

    it('continues cleanup when individual stop fails', async () => {
      const { docker } = createMockDocker();

      const failContainer = {
        stop: vi.fn().mockRejectedValue(new Error('already stopped')),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const okContainer = {
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      docker.listContainers.mockResolvedValue([
        { Id: 'fail-container' },
        { Id: 'ok-container' },
      ]);
      docker.getContainer
        .mockReturnValueOnce(failContainer)
        .mockReturnValueOnce(okContainer);

      const runtime = new ContainerRuntime(docker as any);

      await expect(runtime.cleanupOrphans('prefix-')).resolves.toBeUndefined();

      // The second container should still be cleaned up
      expect(okContainer.stop).toHaveBeenCalled();
      expect(okContainer.remove).toHaveBeenCalled();
    });

    it('handles Docker not available gracefully', async () => {
      const { docker } = createMockDocker();
      docker.listContainers.mockRejectedValue(new Error('connect ENOENT'));
      const runtime = new ContainerRuntime(docker as any);

      await expect(runtime.cleanupOrphans('prefix-')).resolves.toBeUndefined();
    });
  });

  describe('getContainerLogs', () => {
    function createLogMockDocker(logBuffer: Buffer) {
      const mockContainer = {
        logs: vi.fn().mockResolvedValue(logBuffer),
      };
      const docker = {
        getContainer: vi.fn().mockReturnValue(mockContainer),
      };
      return { docker, mockContainer };
    }

    it('demuxes stdout frames', async () => {
      const frame = buildLogFrame(1, 'hello world');
      const { docker } = createLogMockDocker(frame);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('hello world');
      expect(stderr).toBe('');
    });

    it('demuxes stderr frames', async () => {
      const frame = buildLogFrame(2, 'error happened');
      const { docker } = createLogMockDocker(frame);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('');
      expect(stderr).toBe('error happened');
    });

    it('demuxes interleaved stdout and stderr', async () => {
      const buf = Buffer.concat([
        buildLogFrame(1, 'line1\n'),
        buildLogFrame(2, 'err1\n'),
        buildLogFrame(1, 'line2\n'),
        buildLogFrame(2, 'err2\n'),
      ]);
      const { docker } = createLogMockDocker(buf);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('line1\nline2\n');
      expect(stderr).toBe('err1\nerr2\n');
    });

    it('handles multiple consecutive stdout frames', async () => {
      const buf = Buffer.concat([
        buildLogFrame(1, 'part1'),
        buildLogFrame(1, 'part2'),
        buildLogFrame(1, 'part3'),
      ]);
      const { docker } = createLogMockDocker(buf);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('part1part2part3');
      expect(stderr).toBe('');
    });

    it('handles empty log buffer', async () => {
      const { docker } = createLogMockDocker(Buffer.alloc(0));
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    });

    it('handles frame with empty payload (size=0)', async () => {
      const header = Buffer.alloc(8);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(0, 4);
      const { docker } = createLogMockDocker(header);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    });

    it('stops parsing on truncated header (< 8 bytes remaining)', async () => {
      const validFrame = buildLogFrame(1, 'valid');
      // Append 4 bytes of garbage (incomplete header)
      const truncated = Buffer.concat([validFrame, Buffer.from([1, 0, 0, 0])]);
      const { docker } = createLogMockDocker(truncated);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('valid');
      expect(stderr).toBe('');
    });

    it('ignores frames with unknown stream type', async () => {
      const buf = Buffer.concat([
        buildLogFrame(1, 'stdout-data'),
        buildLogFrame(3, 'unknown-type'), // type 3 is not stdout(1) or stderr(2)
        buildLogFrame(2, 'stderr-data'),
      ]);
      const { docker } = createLogMockDocker(buf);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout, stderr } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe('stdout-data');
      expect(stderr).toBe('stderr-data');
    });

    it('handles large payload correctly', async () => {
      const largePayload = 'x'.repeat(100_000);
      const frame = buildLogFrame(1, largePayload);
      const { docker } = createLogMockDocker(frame);
      const runtime = new ContainerRuntime(docker as any);

      const { stdout } = await runtime.getContainerLogs('test-id');
      expect(stdout).toBe(largePayload);
      expect(stdout.length).toBe(100_000);
    });
  });
});
