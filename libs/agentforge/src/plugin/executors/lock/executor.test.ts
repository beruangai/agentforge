import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOLDEN_KATA } from '../../__fixtures__/golden-kata.ts';
import { assembleContainerWorkspace } from '../../container/container-workspace.ts';
import { layerLock } from './executor.ts';

const INPUTS = {
  packageDirectory: '/installed/agentforge',
  rootManifest: '/installed/agentforge/container/package.json',
  rootLock: '/installed/agentforge/container/bun.lock',
};

describe('layerLock', () => {
  it('locks the base layer on AgentForge, seeded with its root lock', () => {
    expect(layerLock(GOLDEN_KATA, 'base', INPUTS, '/workspace')).toEqual({
      rootManifest: INPUTS.rootManifest,
      members: [
        {
          containerPath: 'agentforge',
          manifest: '/installed/agentforge/package.json',
        },
        {
          containerPath: 'agentic',
          manifest: '/workspace/packages/golden-kata/base/agentic/package.json',
        },
      ],
      seed: INPUTS.rootLock,
      out: '/workspace/packages/golden-kata/base/agentic/bun.lock',
    });
  });

  it("locks an agent's layer on the base layer, seeded with its lock", () => {
    const lock = layerLock(GOLDEN_KATA, 'agents/writer', INPUTS, '/workspace');
    expect(lock.members.at(-1)).toEqual({
      containerPath: 'agentic/agent',
      manifest:
        '/workspace/packages/golden-kata/agents/writer/agent/package.json',
    });
    expect(lock.seed).toBe(
      '/workspace/packages/golden-kata/base/agentic/bun.lock',
    );
    expect(lock.out).toBe(
      '/workspace/packages/golden-kata/agents/writer/agent/bun.lock',
    );
  });

  it('refuses an agent the project does not record', () => {
    expect(() =>
      layerLock(GOLDEN_KATA, 'agents/fixer', INPUTS, '/workspace'),
    ).toThrow(
      'layer "agents/fixer" names no agent of @proj/golden-kata: it records writer, grader',
    );
  });

  it('refuses the agentforge layer, whose lock AgentForge ships', () => {
    expect(() =>
      layerLock(GOLDEN_KATA, 'agentforge', INPUTS, '/workspace'),
    ).toThrow("the agentforge layer's lock ships in AgentForge's package");
  });
});

describe('assembleContainerWorkspace', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'agentforge-lock-test-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('recreates the workspace as the layer holds it', async () => {
    const source = join(scratch, 'source');
    for (const [directory, name] of [
      ['root', 'agentforge-container'],
      ['agentforge', '@beruangai/agentforge'],
      ['agentic', '@proj/golden-kata'],
      ['agent', '@proj/golden-kata-writer'],
    ] as const) {
      mkdirSync(join(source, directory), { recursive: true });
      writeFileSync(
        join(source, directory, 'package.json'),
        JSON.stringify({ name }),
      );
    }
    writeFileSync(join(source, 'seed.lock'), 'seed');
    const workspace = join(scratch, 'workspace');
    mkdirSync(workspace);
    await assembleContainerWorkspace(workspace, {
      rootManifest: join(source, 'root/package.json'),
      members: [
        {
          containerPath: 'agentforge',
          manifest: join(source, 'agentforge/package.json'),
        },
        {
          containerPath: 'agentic',
          manifest: join(source, 'agentic/package.json'),
        },
        {
          containerPath: 'agentic/agent',
          manifest: join(source, 'agent/package.json'),
        },
      ],
      seed: join(source, 'seed.lock'),
    });
    const nameAt = (path: string) =>
      (
        JSON.parse(readFileSync(join(workspace, path), 'utf8')) as {
          name: string;
        }
      ).name;
    expect((await readdir(workspace, { recursive: true })).sort()).toEqual([
      'agentforge',
      'agentforge/package.json',
      'agentic',
      'agentic/agent',
      'agentic/agent/package.json',
      'agentic/package.json',
      'bun.lock',
      'package.json',
    ]);
    expect(nameAt('package.json')).toBe('agentforge-container');
    expect(nameAt('agentic/agent/package.json')).toBe(
      '@proj/golden-kata-writer',
    );
    expect(readFileSync(join(workspace, 'bun.lock'), 'utf8')).toBe('seed');
  });
});
