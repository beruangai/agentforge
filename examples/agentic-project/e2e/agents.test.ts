/**
 * Both agents of the agentic project, each in its own container from its own
 * image over the project's agentic base, through AgentForge's client and a
 * real model. The file breaks every house rule; the reviewer must find the
 * mechanical breaks, and the fixer must leave a file without them.
 */
import { randomUUIDv7 } from 'node:crypto';
import {
  awaitTask,
  createClient,
  localTransport,
} from '@beruangai/agentforge/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LocalAgent,
  startLocalAgent,
} from '../../__fixtures__/local-agent.ts';
import { fixer } from '../agents/fixer/src/contract.ts';
import { reviewer } from '../agents/reviewer/src/contract.ts';

const FILE = {
  filename: 'add.ts',
  content: [
    'export function add(a: number, b: number) {',
    '  var total = a + b; // TODO: guard against overflow',
    '  return total;',
    '}',
    '',
  ].join('\n'),
};
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const POLL_OPTIONS = {
  runtimeSessionId: RUNTIME_SESSION_ID,
  pollIntervalMilliseconds: 1_000,
};

let agents: LocalAgent[] = [];
let reviewerClient: ReturnType<typeof createClient<typeof reviewer>>;
let fixerClient: ReturnType<typeof createClient<typeof fixer>>;

beforeAll(async () => {
  const [reviewerAgent, fixerAgent] = await Promise.all([
    startLocalAgent('agentforge-examples/agentic-project-reviewer:local'),
    startLocalAgent('agentforge-examples/agentic-project-fixer:local'),
  ]);
  agents = [reviewerAgent, fixerAgent];
  reviewerClient = createClient(reviewer, localTransport(reviewerAgent.url));
  fixerClient = createClient(fixer, localTransport(fixerAgent.url));
});

afterAll(() => {
  for (const agent of agents) {
    if (process.env.AGENTFORGE_E2E_LOGS) console.log(agent.logs());
    agent.stop();
  }
});

function logs(): string {
  return agents.map((agent) => agent.logs()).join('\n');
}

describe('the agentic project', () => {
  it('reviews a file against the shared house style', async () => {
    const started = await reviewerClient.Review.SendMessage(FILE, {
      runtimeSessionId: RUNTIME_SESSION_ID,
      idempotencyKey: randomUUIDv7(),
    });
    const ended = await awaitTask(reviewerClient.Review, started, POLL_OPTIONS);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.clean).toBe(false);
    const rules = ended.output.findings.map((finding) => finding.rule);
    expect(rules).toEqual(expect.arrayContaining(['R2', 'R3']));
    expect(
      ended.output.findings.every(
        (finding) => finding.line === 2 || finding.rule === 'R1',
      ),
    ).toBe(true);
  });

  it('fixes a file in the workspace, and returns it', async () => {
    const started = await fixerClient.Fix.SendMessage(FILE, {
      runtimeSessionId: RUNTIME_SESSION_ID,
      idempotencyKey: randomUUIDv7(),
    });
    const ended = await awaitTask(fixerClient.Fix, started, POLL_OPTIONS);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.content).not.toMatch(/\bvar\b/);
    expect(ended.output.content).not.toMatch(/TODO/);
    expect(ended.output.rulesApplied).toEqual(
      expect.arrayContaining(['R2', 'R3']),
    );
  });
});
