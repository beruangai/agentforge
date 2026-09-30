/**
 * golden-kata's agents on AgentCore, as golden-kata-infra's `deploy` left
 * them, resolved from the deployment's runtime configuration — as the test
 * role, which may read it.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll } from 'vitest';
import { z } from 'zod';
import { type GoldenKataClient, goldenKataClient } from '../../client.ts';
import { goldenKataSuite } from '../golden-kata.suite.ts';

const OUTPUTS_FILE = new URL(
  '../../../../../dist/packages/examples/golden-kata-infra/deploy/outputs.json',
  import.meta.url,
);
const STACK_NAME = 'agentforge-example-golden-kata-Application';

let client: GoldenKataClient;

beforeAll(async () => {
  const outputs = z
    .object({
      [STACK_NAME]: z.object({ RuntimeConfigApplicationId: z.string() }),
    })
    .parse(JSON.parse(await readFile(OUTPUTS_FILE, 'utf8')));
  client = await goldenKataClient.fromRuntimeConfig({
    applicationId: outputs[STACK_NAME].RuntimeConfigApplicationId,
  });
});

goldenKataSuite(() => client);
