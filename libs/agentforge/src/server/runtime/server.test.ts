import { describe, expect, it } from 'vitest';
import { serverConfig } from './server.ts';

const ENVIRONMENT = {
  AGENTFORGE_AGENT_NAME: 'hello-agent',
  AGENTFORGE_AGENT_IMAGE: 'hello-agent-image',
  AGENTFORGE_TABLE_NAME: 'tasks',
};
const OPTIONS = { taskEntry: 'task.ts', requiredSecrets: [] };

describe('the server config', () => {
  it('takes the image from the environment, or the option over it', () => {
    expect(serverConfig(OPTIONS, ENVIRONMENT).image).toBe('hello-agent-image');
    expect(
      serverConfig({ ...OPTIONS, image: 'given' }, ENVIRONMENT).image,
    ).toBe('given');
  });

  it('refuses to start without the image, naming the variable', () => {
    const { AGENTFORGE_AGENT_IMAGE: _, ...withoutImage } = ENVIRONMENT;
    expect(() => serverConfig(OPTIONS, withoutImage)).toThrow(
      'AGENTFORGE_AGENT_IMAGE must be set to start the AgentForge server',
    );
  });
});
