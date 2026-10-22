import { describe, expect, it } from 'vitest';
import manifest from '../../../../package.json' with { type: 'json' };
import { CLAUDE_AGENT_SDK_VERSION } from './sdk-version.ts';

describe('the pinned Agent SDK version', () => {
  it('is the exact peer the published manifest declares', () => {
    expect(manifest.peerDependencies['@anthropic-ai/claude-agent-sdk']).toBe(
      CLAUDE_AGENT_SDK_VERSION,
    );
  });
});
