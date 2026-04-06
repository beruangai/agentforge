/* eslint-disable @typescript-eslint/no-empty-function */
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageManager } from './image-manager.js';
import type { ContainerRuntime } from '../runner/container-runtime.js';

// Mock the fs module to avoid needing real Dockerfiles
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('FROM oven/bun:latest\nRUN echo hello'),
}));

function createMockRuntime(): {
  [K in 'imageExists' | 'buildImage' | 'inspectImage']: Mock;
} & Partial<ContainerRuntime> {
  return {
    imageExists: vi.fn().mockResolvedValue(false),
    buildImage: vi.fn().mockResolvedValue(undefined),
    inspectImage: vi.fn().mockResolvedValue({ Config: { Labels: {} } }),
  };
}

describe('ImageManager', () => {
  let runtime: ReturnType<typeof createMockRuntime>;
  let manager: ImageManager;

  beforeEach(() => {
    runtime = createMockRuntime();
    manager = new ImageManager(runtime as unknown as ContainerRuntime);
  });

  it('builds image when it does not exist', async () => {
    runtime.imageExists.mockResolvedValue(false);

    await manager.ensureImage({ image: 'agentforge-claude:latest' });

    expect(runtime.buildImage).toHaveBeenCalledWith(
      expect.any(String), // context dir
      'Dockerfile.base', // filename
      'agentforge-claude:latest',
      expect.objectContaining({
        'org.agentforge.dockerfile-hash': expect.any(String),
        'org.agentforge.build-timestamp': expect.any(String),
      }),
    );
  });

  it('does not build when image exists and hash matches', async () => {
    runtime.imageExists.mockResolvedValue(true);
    runtime.inspectImage.mockImplementation(async () => {
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256')
        .update('FROM oven/bun:latest\nRUN echo hello')
        .digest('hex')
        .slice(0, 16);
      return {
        Config: {
          Labels: {
            'org.agentforge.dockerfile-hash': hash,
            'org.agentforge.build-timestamp': Date.now().toString(),
          },
        },
      };
    });

    await manager.ensureImage({ image: 'agentforge-claude:latest' });

    expect(runtime.buildImage).not.toHaveBeenCalled();
  });

  it('rebuilds image when hash does not match', async () => {
    runtime.imageExists.mockResolvedValue(true);
    runtime.inspectImage.mockResolvedValue({
      Config: { Labels: { 'org.agentforge.dockerfile-hash': 'stale-hash' } },
    });

    await manager.ensureImage({ image: 'agentforge-claude:latest' });

    expect(runtime.buildImage).toHaveBeenCalledOnce();
  });

  it('rebuilds image when no hash label exists', async () => {
    runtime.imageExists.mockResolvedValue(true);
    runtime.inspectImage.mockResolvedValue({
      Config: { Labels: {} },
    });

    await manager.ensureImage({ image: 'agentforge-claude:latest' });

    expect(runtime.buildImage).toHaveBeenCalledOnce();
  });

  it('uses custom dockerfile path', async () => {
    runtime.imageExists.mockResolvedValue(false);

    await manager.ensureImage({
      image: 'custom-image:latest',
      dockerfile: '/custom/path/MyDockerfile',
    });

    expect(runtime.buildImage).toHaveBeenCalledWith(
      '/custom/path',
      'MyDockerfile',
      'custom-image:latest',
      expect.objectContaining({
        'org.agentforge.dockerfile-hash': expect.any(String),
        'org.agentforge.build-timestamp': expect.any(String),
      }),
    );
  });

  it('deduplicates concurrent builds', async () => {
    runtime.imageExists.mockResolvedValue(false);
    let resolveBuild!: () => void;
    runtime.buildImage.mockReturnValue(
      new Promise<void>((r) => {
        resolveBuild = r;
      }),
    );

    const p1 = manager.ensureImage({ image: 'test:latest' });
    // Yield so the first ensureImage starts its build
    await new Promise((r) => setTimeout(r, 0));
    const p2 = manager.ensureImage({ image: 'test:latest' });

    resolveBuild();
    await Promise.all([p1, p2]);

    // Should only build once despite two concurrent calls
    expect(runtime.buildImage).toHaveBeenCalledTimes(1);
  });

  describe('drift warning', () => {
    it('warns when image is older than 7 days', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

      runtime.imageExists.mockResolvedValue(true);
      runtime.inspectImage.mockImplementation(async () => {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256')
          .update('FROM oven/bun:latest\nRUN echo hello')
          .digest('hex')
          .slice(0, 16);
        return {
          Config: {
            Labels: {
              'org.agentforge.dockerfile-hash': hash,
              'org.agentforge.build-timestamp': eightDaysAgo.toString(),
            },
          },
        };
      });

      await manager.ensureImage({ image: 'agentforge-claude:latest' });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('8 days ago'),
      );
      expect(runtime.buildImage).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when image is recent', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      runtime.imageExists.mockResolvedValue(true);
      runtime.inspectImage.mockImplementation(async () => {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256')
          .update('FROM oven/bun:latest\nRUN echo hello')
          .digest('hex')
          .slice(0, 16);
        return {
          Config: {
            Labels: {
              'org.agentforge.dockerfile-hash': hash,
              'org.agentforge.build-timestamp': Date.now().toString(),
            },
          },
        };
      });

      await manager.ensureImage({ image: 'agentforge-claude:latest' });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when no timestamp label exists', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      runtime.imageExists.mockResolvedValue(true);
      runtime.inspectImage.mockImplementation(async () => {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256')
          .update('FROM oven/bun:latest\nRUN echo hello')
          .digest('hex')
          .slice(0, 16);
        return {
          Config: {
            Labels: {
              'org.agentforge.dockerfile-hash': hash,
            },
          },
        };
      });

      await manager.ensureImage({ image: 'agentforge-claude:latest' });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
