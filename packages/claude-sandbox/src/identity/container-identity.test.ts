import { describe, expect, it } from 'vitest';

import { containerName, taskIdentityHash } from './container-identity.js';
import type { VolumeMap } from '../runner/types.js';

describe('taskIdentityHash', () => {
  it('generates deterministic hash from same config', () => {
    const volumes: VolumeMap = {
      '/host/data': '/workspace/data',
      '/host/context': { target: '/workspace/context', readonly: true },
    };

    const hash1 = taskIdentityHash(
      'my-task',
      'agentforge-claude:latest',
      volumes,
    );
    const hash2 = taskIdentityHash(
      'my-task',
      'agentforge-claude:latest',
      volumes,
    );

    expect(hash1).toBe(hash2);
  });

  it('generates different hash for different volumes', () => {
    const hash1 = taskIdentityHash('my-task', 'agentforge-claude:latest', {
      '/host/data-a': '/workspace/data',
    });
    const hash2 = taskIdentityHash('my-task', 'agentforge-claude:latest', {
      '/host/data-b': '/workspace/data',
    });

    expect(hash1).not.toBe(hash2);
  });

  it('generates different hash for different image', () => {
    const hash1 = taskIdentityHash('my-task', 'agentforge-claude:v1', {});
    const hash2 = taskIdentityHash('my-task', 'agentforge-claude:v2', {});

    expect(hash1).not.toBe(hash2);
  });

  it('generates different hash for different task name', () => {
    const hash1 = taskIdentityHash('task-a', 'agentforge-claude:latest');
    const hash2 = taskIdentityHash('task-b', 'agentforge-claude:latest');

    expect(hash1).not.toBe(hash2);
  });

  it('returns 12-char hex string', () => {
    const hash = taskIdentityHash('research', 'agentforge-claude:latest');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('handles empty volumes', () => {
    const hash1 = taskIdentityHash('task', 'image:latest');
    const hash2 = taskIdentityHash('task', 'image:latest', {});

    expect(hash1).toBe(hash2);
  });

  it('is order-independent for volumes', () => {
    const hash1 = taskIdentityHash('task', 'image:latest', {
      '/a': '/wa',
      '/b': '/wb',
    });
    const hash2 = taskIdentityHash('task', 'image:latest', {
      '/b': '/wb',
      '/a': '/wa',
    });

    expect(hash1).toBe(hash2);
  });
});

describe('containerName', () => {
  it('follows agentforge-<name>-<id> pattern', () => {
    const name = containerName('research', 'abc12345');
    expect(name).toBe('agentforge-research-abc12345');
  });

  it('sanitizes task name for Docker compatibility', () => {
    const name = containerName('My Task/Name!', 'abc12345');
    expect(name).toBe('agentforge-my-task-name-abc12345');
  });

  it('produces unique names with different execution IDs', () => {
    const name1 = containerName('task', 'aaa11111');
    const name2 = containerName('task', 'bbb22222');

    expect(name1).not.toBe(name2);
  });
});
