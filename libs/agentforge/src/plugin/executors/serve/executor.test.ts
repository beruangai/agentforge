import { describe, expect, it } from 'vitest';
import { GOLDEN_KATA } from '../../__fixtures__/golden-kata.ts';
import {
  type ContainerState,
  cleanupCommands,
  servePlan,
  serveRefusal,
  startCommands,
} from './executor.ts';

const PLAN = servePlan(GOLDEN_KATA, 'writer', []);
const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: 'token' };
const stateIs = (state: ContainerState) => () => state;

describe('servePlan', () => {
  it("serves the agent's image under its container name", () => {
    expect(PLAN).toEqual({
      network: 'proj-golden-kata-writer',
      dynamoDB: 'proj-golden-kata-writer-dynamodb',
      agent: 'proj-golden-kata-writer',
      image: 'proj/golden-kata-writer:local',
      secrets: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it("requires AgentForge's secrets, then its layers', once each", () => {
    expect(
      servePlan(GOLDEN_KATA, 'writer', [
        'KATA_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]).secrets,
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'KATA_API_KEY']);
  });

  it('refuses an agent the project does not record', () => {
    expect(() => servePlan(GOLDEN_KATA, 'fixer', [])).toThrow(
      '@proj/golden-kata records no agent fixer: it records writer, grader',
    );
  });
});

describe('serveRefusal', () => {
  it('refuses without every secret the agent requires, naming each', () => {
    expect(
      serveRefusal(
        servePlan(GOLDEN_KATA, 'writer', ['KATA_API_KEY']),
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
      servePlan(GOLDEN_KATA, 'writer', ['KATA_API_KEY']),
    );
    expect(agent.join(' ')).toContain(
      '--env CLAUDE_CODE_OAUTH_TOKEN --env KATA_API_KEY',
    );
    expect(agent).toContain('127.0.0.1::9000');
    expect(agent.join(' ')).not.toContain('token=');
    expect(agent).toContain(
      'AGENTFORGE_DYNAMODB_ENDPOINT=http://proj-golden-kata-writer-dynamodb:8000',
    );
    expect(agent.at(-1)).toBe('proj/golden-kata-writer:local');
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
