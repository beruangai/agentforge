// biome-ignore-all format: a @ts-expect-error covers only the line after it, so reflowing a probe would move its error off that line
/**
 * Type probes, compiled by the `typecheck` target (`tsconfig.spec.json`
 * includes `integ/`) under the project's strict settings. Each
 * `@ts-expect-error` must still be an error; one that stops erroring is
 * reported as unused (TS2578) and fails `typecheck`.
 */
import { type ClientLink, createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { expectTypeOf } from 'vitest';
import {
  type CallerContext,
  type cancellationContract,
  createCancellableClient,
} from './cancellation-and-typed-link.ts';

export async function clientContextProbes() {
  const { client } = createCancellableClient();

  // @ts-expect-error a call with no client context does not compile: the idempotency key cannot be forgotten, and no procedure had to declare it
  await client.SendMessage({ strategyId: 'a' });
  // @ts-expect-error nor with the wrong client context
  await client.SendMessage({ strategyId: 'a' }, { context: { idempotency: 'a' } });

  const handle = await client.SendMessage({ strategyId: 'a' }, { context: { idempotencyKey: 'k' } });
  expectTypeOf(handle.state).toEqualTypeOf<'TASK_STATE_SUBMITTED'>();
}

/**
 * A link that DEMANDS MORE than the client promises is rejected, so the two
 * halves cannot drift apart.
 *
 * NOT a hole, and NOT probed as one: a link may declare a LOOSER context than
 * the client requires. That is ordinary contravariance — the link ignores what
 * it is handed. The requirement is enforced by the CLIENT's annotation, which
 * is therefore AgentForge's to vend and never a consumer's to write.
 */
export function demandingLinkProbe() {
  const demanding: ClientLink<CallerContext & { tenant: string }> = {
    async call(_path, _input, options) {
      return options.context.tenant;
    },
  };
  // @ts-expect-error the client only promises an idempotencyKey
  const mismatched: ContractRouterClient<typeof cancellationContract, CallerContext> = createORPCClient(demanding);
  return mismatched;
}
