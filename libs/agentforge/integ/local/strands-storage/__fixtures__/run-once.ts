/**
 * One `strands` run in its own process, as a task process runs it: storage
 * from the environment, the scripted API at `SCRIPTED_ANTHROPIC_URL`. Prints
 * the run's session id and output as one JSON line.
 */
import { z } from 'zod';
import { runAgent } from '../../../../src/framework/strands/harness/runner.ts';
import { storageFromEnvironment } from '../../../../src/framework/strands/harness/storage.ts';

const [prompt, resume] = process.argv.slice(2);
if (prompt === undefined)
  throw new Error('usage: run-once.ts <prompt> [resume]');
const baseURL = process.env.SCRIPTED_ANTHROPIC_URL;
if (baseURL === undefined) throw new Error('SCRIPTED_ANTHROPIC_URL is unset');
const storage = storageFromEnvironment();
if (storage === undefined)
  throw new Error('AGENTFORGE_SESSION_BUCKET is unset');

const run = await runAgent(
  {
    prompt,
    output: z.object({ answer: z.string() }),
    options: { model: 'claude-test', maxTokens: 1024 },
    ...(resume === undefined ? {} : { resume }),
  },
  { signal: new AbortController().signal, onRecord: () => undefined },
  {
    apiKey: 'test-key',
    layers: [],
    storage,
    clientConfig: { baseURL, maxRetries: 0 },
    retryStrategy: null,
  },
);
process.stdout.write(
  `${JSON.stringify({ sessionId: run.sessionId, output: run.output })}\n`,
);
