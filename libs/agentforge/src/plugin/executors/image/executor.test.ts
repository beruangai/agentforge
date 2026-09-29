import { describe, expect, it } from 'vitest';
import { GOLDEN_KATA } from '../../__fixtures__/golden-kata.ts';
import { imageBuild } from './executor.ts';

const INPUTS = {
  packageDirectory: '/installed/agentforge',
  dockerfile: '/installed/agentforge/Dockerfile',
  containerDirectory: '/installed/agentforge/container',
  version: '1.2.3',
};

describe('imageBuild', () => {
  it('builds the AgentForge image from the installed package', () => {
    expect(imageBuild(GOLDEN_KATA, 'agentforge', INPUTS, '/workspace')).toEqual(
      {
        args: [
          'build',
          '--platform',
          'linux/arm64',
          '--file',
          '/installed/agentforge/Dockerfile',
          '--build-context',
          'container=/installed/agentforge/container',
          '--tag',
          'agentforge/a2a-claude:1.2.3',
          '--iidfile',
          '/workspace/dist/packages/golden-kata/image/agentforge.id',
          '/installed/agentforge',
        ],
        tag: 'agentforge/a2a-claude:1.2.3',
        idFile: '/workspace/dist/packages/golden-kata/image/agentforge.id',
      },
    );
  });

  it('builds the agentic image from the base layer, on the AgentForge image', () => {
    expect(imageBuild(GOLDEN_KATA, 'base', INPUTS, '/workspace').args).toEqual([
      'build',
      '--platform',
      'linux/arm64',
      '--build-arg',
      'BASE_IMAGE=agentforge/a2a-claude:1.2.3',
      '--tag',
      'proj/golden-kata:local',
      '--iidfile',
      '/workspace/dist/packages/golden-kata/image/base.id',
      '/workspace/packages/golden-kata/base',
    ]);
  });

  it("builds an agent's image from its layer, on the agentic image", () => {
    expect(
      imageBuild(GOLDEN_KATA, 'agents/grader', INPUTS, '/workspace'),
    ).toEqual({
      args: [
        'build',
        '--platform',
        'linux/arm64',
        '--build-arg',
        'BASE_IMAGE=proj/golden-kata:local',
        '--tag',
        'proj/golden-kata-grader:local',
        '--iidfile',
        '/workspace/dist/packages/golden-kata/image/agents/grader.id',
        '/workspace/packages/golden-kata/agents/grader',
      ],
      tag: 'proj/golden-kata-grader:local',
      idFile: '/workspace/dist/packages/golden-kata/image/agents/grader.id',
    });
  });

  it('refuses a layer that is not one', () => {
    expect(() => imageBuild(GOLDEN_KATA, 'top', INPUTS, '/workspace')).toThrow(
      'layer "top" is not agentforge, base or agents/<agent>',
    );
  });
});
