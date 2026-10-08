import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_KATA } from '../../__fixtures__/golden-kata.ts';
import {
  builtImageId,
  type ContainerState,
  cleanupCommands,
  servePlan,
  serveRefusal,
  startCommands,
} from './executor.ts';

const IMAGE_ID = 'sha256:0123abcd';
const PLAN = servePlan(GOLDEN_KATA, 'writer', [], IMAGE_ID);
const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: 'token' };
const stateIs = (state: ContainerState) => () => state;

describe('servePlan', () => {
  it("serves the agent's image under its container name", () => {
    expect(PLAN).toEqual({
      network: 'proj-golden-kata-writer',
      dynamoDB: 'proj-golden-kata-writer-dynamodb',
      agent: 'proj-golden-kata-writer',
      image: IMAGE_ID,
      secrets: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it("requires AgentForge's secrets, then its layers', once each", () => {
    expect(
      servePlan(
        GOLDEN_KATA,
        'writer',
        ['KATA_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        IMAGE_ID,
      ).secrets,
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'KATA_API_KEY']);
  });

  it('refuses an agent the project does not record', () => {
    expect(() => servePlan(GOLDEN_KATA, 'fixer', [], IMAGE_ID)).toThrow(
      '@proj/golden-kata records no agent fixer: it records writer, grader',
    );
  });
});

describe('builtImageId', () => {
  it('reads the id the agent image build wrote', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentforge-serve-'));
    const directory = join(root, 'dist/packages/golden-kata/image/agents');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'writer.id'), `${IMAGE_ID}\n`);
    expect(builtImageId(root, GOLDEN_KATA, 'writer')).toBe(IMAGE_ID);
  });

  it('refuses without it, naming the build that writes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentforge-serve-'));
    expect(() => builtImageId(root, GOLDEN_KATA, 'writer')).toThrow(
      /writer\.id is missing: build the agent's image first, with nx run @proj\/golden-kata:image-writer/,
    );
  });
});

describe('serveRefusal', () => {
  it('refuses without every secret the agent requires, naming each', () => {
    expect(
      serveRefusal(
        servePlan(GOLDEN_KATA, 'writer', ['KATA_API_KEY'], IMAGE_ID),
        {},
        stateIs('absent'),
      ),
    ).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN, KATA_API_KEY not set; the serve configuration loads the agent's secrets from .env.serve.local",
    );
  });

  it('refuses an agent already being served, naming its container', () => {
    expect(serveRefusal(PLAN, TOKEN, stateIs('running'))).toBe(
      'proj-golden-kata-writer is already being served',
    );
  });

  it('refuses over a stopped container of the same name', () => {
    expect(serveRefusal(PLAN, TOKEN, stateIs('stopped'))).toMatch(
      /stopped container named proj-golden-kata-writer/,
    );
  });

  it('serves with the token and no container of its name', () => {
    expect(serveRefusal(PLAN, TOKEN, stateIs('absent'))).toBeUndefined();
  });
});

describe('the docker commands', () => {
  it('passes each secret by name, never its value, on a host-assigned port', () => {
    const { agent } = startCommands(
      servePlan(GOLDEN_KATA, 'writer', ['KATA_API_KEY'], IMAGE_ID),
    );
    expect(agent.join(' ')).toContain(
      '--env CLAUDE_CODE_OAUTH_TOKEN --env KATA_API_KEY',
    );
    expect(agent).toContain('127.0.0.1::9000');
    expect(agent.join(' ')).not.toContain('token=');
    expect(agent).toContain(
      'AGENTFORGE_DYNAMODB_ENDPOINT=http://proj-golden-kata-writer-dynamodb:8000',
    );
    expect(agent.join(' ')).toContain(
      `--env AGENTFORGE_AGENT_IMAGE=${IMAGE_ID} ${IMAGE_ID}`,
    );
    expect(agent.at(-1)).toBe(IMAGE_ID);
  });

  it('removes both containers and the network on stop', () => {
    expect(cleanupCommands(PLAN)).toEqual([
      [
        'rm',
        '--force',
        'proj-golden-kata-writer',
        'proj-golden-kata-writer-dynamodb',
      ],
      ['network', 'rm', 'proj-golden-kata-writer'],
    ]);
  });
});
