import { describe, expect, it } from 'vitest';
import { GOLDEN_KATA } from '../__fixtures__/golden-kata.ts';
import { agentOfLayer } from './images.ts';

describe('agentOfLayer', () => {
  it('names no agent for the base, framework and agentic layers', () => {
    for (const layer of ['agentforge', 'agentforge-claude', 'base']) {
      expect(agentOfLayer(GOLDEN_KATA, layer)).toBeUndefined();
    }
  });

  it("names an agent's layer, and refuses one that is no layer or no recorded agent's", () => {
    expect(agentOfLayer(GOLDEN_KATA, 'agents/writer')).toBe('writer');
    expect(() => agentOfLayer(GOLDEN_KATA, 'top')).toThrow(
      'layer "top" is not agentforge, agentforge-claude, agentforge-strands, base or agents/<agent>',
    );
    expect(() => agentOfLayer(GOLDEN_KATA, 'agents/fixer')).toThrow(
      'layer "agents/fixer" names no agent of @proj/golden-kata',
    );
  });
});
