import { describe, expect, it } from 'vitest';
import manifest from '../../../../package.json' with { type: 'json' };
import containerManifest from '../container/package.json' with { type: 'json' };
import { STRANDS_SDK_VERSION } from './sdk-version.ts';

describe('the Strands SDK version', () => {
  it('is the floor of the peer range the published manifest declares', () => {
    expect(manifest.peerDependencies['@strands-agents/sdk']).toBe(
      `^${STRANDS_SDK_VERSION}`,
    );
  });

  it('is the version the image installs', () => {
    expect(containerManifest.dependencies['@strands-agents/sdk']).toBe(
      STRANDS_SDK_VERSION,
    );
  });
});
