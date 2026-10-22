import { describe, expect, it } from 'vitest';
import { isAgentTarget } from './targets.ts';

const IMAGE = { executor: '@beruangai/agentforge:image' };

describe('isAgentTarget', () => {
  it("is an agent's lock, image or serve target", () => {
    for (const name of ['lock-writer', 'image-writer', 'serve-writer']) {
      expect(isAgentTarget(name, IMAGE)).toBe(true);
    }
  });

  it("is not AgentForge's base or framework image target, nor another executor's", () => {
    expect(isAgentTarget('image-agentforge', IMAGE)).toBe(false);
    expect(isAgentTarget('image-agentforge-claude', IMAGE)).toBe(false);
    expect(isAgentTarget('image-writer', { executor: 'nx:run-commands' })).toBe(
      false,
    );
  });
});
