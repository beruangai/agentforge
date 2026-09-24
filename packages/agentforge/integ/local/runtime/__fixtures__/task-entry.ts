import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { cause } from '../../../../src/core/contract/task.ts';
import { TaskFailure } from '../../../../src/server/harness/kernel.ts';
import {
  implementAgent,
  runTaskProcess,
} from '../../../../src/server/harness/task-process.ts';
import { runtimeContract } from './contract.ts';

const os = implementAgent(runtimeContract);

runTaskProcess({
  contract: runtimeContract,
  router: os.router({
    echo: os.echo.handler(async ({ input, context }) => ({
      text: input.text,
      attempt: context.attempt,
    })),
    wait: os.wait.handler(async ({ input, context }) => {
      try {
        await delay(input.milliseconds, undefined, { signal: context.signal });
        return { waited: true };
      } catch {
        return { waited: false };
      }
    }),
    stubborn: os.stubborn.handler(async ({ input }) => {
      const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' });
      writeFileSync(input.pidFile, String(grandchild.pid));
      process.on('message', () => undefined);
      await delay(300_000);
      return {};
    }),
    flaky: os.flaky.handler(async ({ context }) => {
      if (context.attempt === 1) {
        throw new TaskFailure(
          cause('PROVIDER_TRANSIENT', 'the first attempt always fails'),
        );
      }
      return {
        attempt: context.attempt,
        priorState: context.priorAttempt?.state ?? 'none',
      };
    }),
    crash: os.crash.handler(async () => {
      console.error('about to crash on purpose');
      process.exit(3);
    }),
  }),
});
