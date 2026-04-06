import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionMountPath } from './sessions.js';

describe('sessionMountPath', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `agentforge-test-sessions-${Date.now()}`);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates session directory if it does not exist', () => {
    const result = sessionMountPath(testDir, 'agentforge-task-abc123');
    expect(existsSync(result)).toBe(true);
    expect(result).toBe(join(testDir, 'agentforge-task-abc123', '.claude'));
  });

  it('returns existing directory without error', () => {
    const result1 = sessionMountPath(testDir, 'agentforge-task-abc123');
    const result2 = sessionMountPath(testDir, 'agentforge-task-abc123');
    expect(result1).toBe(result2);
  });

  it('creates separate directories for different container names', () => {
    const path1 = sessionMountPath(testDir, 'agentforge-task-a-111111111111');
    const path2 = sessionMountPath(testDir, 'agentforge-task-b-222222222222');

    expect(path1).not.toBe(path2);
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);
  });

  it('creates .claude subdirectory', () => {
    const result = sessionMountPath(testDir, 'container-name');
    expect(result).toContain('.claude');
    expect(result.endsWith('.claude')).toBe(true);
  });
});
