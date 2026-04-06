import { describe, expect, it } from 'vitest';

import type { VolumeMap } from '../runner/types.js';
import { resolveVolumes } from './volume-resolver.js';

describe('resolveVolumes', () => {
  it('returns empty array for undefined volumes', () => {
    expect(resolveVolumes(undefined)).toEqual([]);
  });

  it('returns empty array for empty volumes', () => {
    expect(resolveVolumes({})).toEqual([]);
  });

  it('resolves simple string volume mounts', () => {
    const volumes: VolumeMap = {
      '/host/data': '/workspace/data',
      '/host/context': '/workspace/context',
    };

    const binds = resolveVolumes(volumes);
    expect(binds).toEqual([
      '/host/data:/workspace/data',
      '/host/context:/workspace/context',
    ]);
  });

  it('resolves readonly volume mounts', () => {
    const volumes: VolumeMap = {
      '/host/context': { target: '/workspace/context', readonly: true },
    };

    const binds = resolveVolumes(volumes);
    expect(binds).toEqual(['/host/context:/workspace/context:ro']);
  });

  it('resolves writable object-style mounts', () => {
    const volumes: VolumeMap = {
      '/host/data': { target: '/workspace/data', readonly: false },
    };

    const binds = resolveVolumes(volumes);
    expect(binds).toEqual(['/host/data:/workspace/data']);
  });

  it('resolves mixed string and object mounts', () => {
    const volumes: VolumeMap = {
      '/host/data': '/workspace/data',
      '/host/context': { target: '/workspace/context', readonly: true },
      '/host/output': { target: '/workspace/output' },
    };

    const binds = resolveVolumes(volumes);
    expect(binds).toContain('/host/data:/workspace/data');
    expect(binds).toContain('/host/context:/workspace/context:ro');
    expect(binds).toContain('/host/output:/workspace/output');
  });
});
