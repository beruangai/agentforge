import { describe, expect, it } from 'vitest';
import { runWorker } from './worker.ts';

const LOCAL = {
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
};
const OPTIONS = {
  taskQueue: 'queue',
  workflowBundle: new URL('./absent/workflows.js', import.meta.url),
  activities: {},
  agentActivities: {},
  requiredSecrets: [],
};
const activity = async () => undefined;

describe('runWorker refuses to start', () => {
  it('without its required secrets, naming each', async () => {
    await expect(
      runWorker({
        ...OPTIONS,
        requiredSecrets: ['FIRST', 'SECOND', 'THIRD'],
        environment: { ...LOCAL, SECOND: 'set', THIRD: '' },
      }),
    ).rejects.toThrow('required secrets unset: FIRST, THIRD');
  });

  it("with an activity named as a connected agent's", async () => {
    await expect(
      runWorker({
        ...OPTIONS,
        activities: { 'goldenKata.writer.Write': activity, mine: activity },
        agentActivities: { 'goldenKata.writer.Write': activity },
        environment: LOCAL,
      }),
    ).rejects.toThrow(
      "activities named as a connected agent's: goldenKata.writer.Write",
    );
  });

  it('without its workflow bundle, naming the target that builds it', async () => {
    await expect(runWorker({ ...OPTIONS, environment: LOCAL })).rejects.toThrow(
      /workflows\.js is missing: build it with the project's `bundle-workflows` target/,
    );
  });

  it('without its connection, naming each variable', async () => {
    await expect(runWorker({ ...OPTIONS, environment: {} })).rejects.toThrow(
      'TEMPORAL_ADDRESS is unset; TEMPORAL_NAMESPACE is unset',
    );
  });
});
