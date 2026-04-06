import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateEnvShadowMounts } from './env-shadow.js';

describe('generateEnvShadowMounts', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `env-shadow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for empty binds', () => {
    expect(generateEnvShadowMounts([])).toEqual([]);
  });

  it('returns empty array when no .env files exist in mounted dirs', () => {
    mkdirSync(join(testDir, 'project'), { recursive: true });
    writeFileSync(join(testDir, 'project', 'index.ts'), 'console.log("hello")');

    const binds = [`${join(testDir, 'project')}:/workspace/data`];
    expect(generateEnvShadowMounts(binds)).toEqual([]);
  });

  it('shadows root .env file', () => {
    const hostDir = join(testDir, 'project');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, '.env'), 'SECRET=foo');

    const binds = [`${hostDir}:/workspace/data`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toEqual(['/dev/null:/workspace/data/.env']);
  });

  it('shadows nested .env files', () => {
    const hostDir = join(testDir, 'project');
    mkdirSync(join(hostDir, 'services', 'api'), { recursive: true });
    writeFileSync(join(hostDir, '.env'), 'ROOT_SECRET=1');
    writeFileSync(join(hostDir, 'services', 'api', '.env'), 'API_SECRET=2');

    const binds = [`${hostDir}:/workspace/data`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toContain('/dev/null:/workspace/data/.env');
    expect(shadows).toContain('/dev/null:/workspace/data/services/api/.env');
    expect(shadows).toHaveLength(2);
  });

  it('shadows .env.local and .env.production variants', () => {
    const hostDir = join(testDir, 'project');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, '.env'), 'BASE=1');
    writeFileSync(join(hostDir, '.env.local'), 'LOCAL=2');
    writeFileSync(join(hostDir, '.env.production'), 'PROD=3');

    const binds = [`${hostDir}:/workspace/data`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toContain('/dev/null:/workspace/data/.env');
    expect(shadows).toContain('/dev/null:/workspace/data/.env.local');
    expect(shadows).toContain('/dev/null:/workspace/data/.env.production');
    expect(shadows).toHaveLength(3);
  });

  it('shadows .env files in read-only mounts', () => {
    const hostDir = join(testDir, 'project');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, '.env'), 'SECRET=foo');

    const binds = [`${hostDir}:/workspace/data:ro`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toEqual(['/dev/null:/workspace/data/.env']);
  });

  it('handles non-existent host paths gracefully', () => {
    const binds = [`${join(testDir, 'does-not-exist')}:/workspace/data`];
    expect(generateEnvShadowMounts(binds)).toEqual([]);
  });

  it('does not follow symlinks', () => {
    const hostDir = join(testDir, 'project');
    const secretDir = join(testDir, 'secrets');
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, '.env'), 'SYMLINKED_SECRET=1');
    symlinkSync(secretDir, join(hostDir, 'linked-secrets'));

    const binds = [`${hostDir}:/workspace/data`];
    const shadows = generateEnvShadowMounts(binds);

    // Should not contain anything from the symlinked directory
    expect(shadows).toEqual([]);
  });

  it('handles multiple bind mounts', () => {
    const dir1 = join(testDir, 'proj1');
    const dir2 = join(testDir, 'proj2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, '.env'), 'A=1');
    writeFileSync(join(dir2, '.env.local'), 'B=2');

    const binds = [`${dir1}:/workspace/proj1`, `${dir2}:/workspace/proj2`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toContain('/dev/null:/workspace/proj1/.env');
    expect(shadows).toContain('/dev/null:/workspace/proj2/.env.local');
    expect(shadows).toHaveLength(2);
  });

  it('ignores files that do not match .env pattern', () => {
    const hostDir = join(testDir, 'project');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, '.envrc'), 'not an env file');
    writeFileSync(join(hostDir, 'env'), 'also not');
    writeFileSync(join(hostDir, '.env'), 'this one counts');

    const binds = [`${hostDir}:/workspace/data`];
    const shadows = generateEnvShadowMounts(binds);

    expect(shadows).toEqual(['/dev/null:/workspace/data/.env']);
  });
});
