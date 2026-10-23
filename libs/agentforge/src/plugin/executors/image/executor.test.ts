import { describe, expect, it } from 'vitest';
import { FRAMEWORK_NAMES } from '#core/contract/framework.ts';
import { GOLDEN_KATA } from '../../__fixtures__/golden-kata.ts';
import { frameworkLayer } from '../../container/images.ts';
import { imageBuild } from './executor.ts';
import schema from './schema.json' with { type: 'json' };

const INPUTS = {
  packageDirectory: '/installed/agentforge',
  dockerfile: '/installed/agentforge/Dockerfile',
  containerDirectory: '/installed/agentforge/container',
  version: '1.2.3',
  frameworks: {
    claude: {
      dockerfile: '/installed/agentforge/claude/Dockerfile',
      containerDirectory: '/installed/agentforge/claude/container',
      rootManifest: '/installed/agentforge/claude/container/package.json',
      rootLock: '/installed/agentforge/claude/container/bun.lock',
    },
  },
};

describe('imageBuild', () => {
  it('builds the AgentForge base image from the installed package', () => {
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
          'agentforge/a2a:1.2.3',
          '--iidfile',
          '/workspace/dist/packages/golden-kata/image/agentforge.id',
          '/installed/agentforge',
        ],
        tag: 'agentforge/a2a:1.2.3',
        idFile: '/workspace/dist/packages/golden-kata/image/agentforge.id',
      },
    );
  });

  it("builds the project's framework image from the installed package, on the base image", () => {
    expect(
      imageBuild(GOLDEN_KATA, 'agentforge-claude', INPUTS, '/workspace'),
    ).toEqual({
      args: [
        'build',
        '--platform',
        'linux/arm64',
        '--file',
        '/installed/agentforge/claude/Dockerfile',
        '--build-arg',
        'BASE_IMAGE=agentforge/a2a:1.2.3',
        '--build-context',
        'container=/installed/agentforge/claude/container',
        '--tag',
        'agentforge/a2a-claude:1.2.3',
        '--iidfile',
        '/workspace/dist/packages/golden-kata/image/agentforge-claude.id',
        '/installed/agentforge/claude/container',
      ],
      tag: 'agentforge/a2a-claude:1.2.3',
      idFile: '/workspace/dist/packages/golden-kata/image/agentforge-claude.id',
    });
  });

  it('builds the agentic image from the base layer, on the framework image', () => {
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

  it("accepts every layer in its schema, a framework's included", () => {
    const pattern = new RegExp(schema.properties.layer.pattern);
    for (const layer of [
      'agentforge',
      ...FRAMEWORK_NAMES.map((framework) => frameworkLayer(framework)),
      'base',
      'agents/grader',
    ]) {
      expect(layer).toMatch(pattern);
    }
    expect('top').not.toMatch(pattern);
  });

  it('refuses a layer that is not one', () => {
    expect(() => imageBuild(GOLDEN_KATA, 'top', INPUTS, '/workspace')).toThrow(
      'layer "top" is not agentforge, agentforge-claude, base or agents/<agent>',
    );
  });

  it("adds a project layer's named build contexts, from the workspace root, and refuses them for AgentForge's", () => {
    expect(
      imageBuild(GOLDEN_KATA, 'agents/grader', INPUTS, '/workspace', {
        validation: 'dist/packages/rnd/validation',
      }).args,
    ).toEqual(
      expect.arrayContaining([
        '--build-context',
        'validation=/workspace/dist/packages/rnd/validation',
      ]),
    );
    expect(() =>
      imageBuild(GOLDEN_KATA, 'agentforge', INPUTS, '/workspace', {
        validation: 'dist',
      }),
    ).toThrow(/AgentForge's/);
    expect(() =>
      imageBuild(GOLDEN_KATA, 'agentforge-claude', INPUTS, '/workspace', {
        validation: 'dist',
      }),
    ).toThrow(/AgentForge's/);
  });
});
