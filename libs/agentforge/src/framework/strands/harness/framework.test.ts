import { describe, expect, it } from 'vitest';
import { runnerContextFromEnvironment } from './framework.ts';

describe('runnerContextFromEnvironment', () => {
  it('refuses a run without the API key', () => {
    expect(() =>
      runnerContextFromEnvironment({}, '/workspace/agentic/agent'),
    ).toThrow('ANTHROPIC_API_KEY is unset');
  });

  it("takes the key, the agent's name and the layers base first", () => {
    const context = runnerContextFromEnvironment(
      { ANTHROPIC_API_KEY: 'k', AGENTFORGE_AGENT_NAME: 'writer' },
      '/workspace/agentic/agent',
    );
    expect(context).toMatchObject({
      apiKey: 'k',
      agentName: 'writer',
      layers: ['/workspace/agentic', '/workspace/agentic/agent'],
    });
    expect(context.storage).toBeUndefined();
  });
});
