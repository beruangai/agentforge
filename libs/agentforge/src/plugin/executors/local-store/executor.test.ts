import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localStoreCommand } from './executor.ts';

describe('local-store', () => {
  it('starts the shared store until healthy, or stops it, under one compose project', () => {
    const start = localStoreCommand({});
    expect(start.slice(0, 3)).toEqual([
      'compose',
      '--project-name',
      'agentforge-store',
    ]);
    expect(existsSync(start[4] ?? '')).toBe(true);
    expect(start.slice(5)).toEqual(['up', '--detach', '--wait']);
    expect(localStoreCommand({ stop: true }).slice(5)).toEqual(['down']);
  });
});
