// biome-ignore-all format: a @ts-expect-error covers only the line after it, so reflowing a probe would move its error off that line
/**
 * Type probes, compiled by the `typecheck` target (`tsconfig.spec.json`
 * includes `integ/`) under the project's strict settings. Each
 * `@ts-expect-error` must still be an error; one that stops erroring is
 * reported as unused (TS2578) and fails `typecheck`.
 */
import { expectTypeOf } from 'vitest';
import {
  base,
  createLinkedClient,
  withAudit,
  withLease,
} from './custom-link-and-typed-context.ts';

/** The client is typed through a link that knows nothing about HTTP. */
export async function clientTypeProbes() {
  const { client } = createLinkedClient({ idempotencyKey: 'k', attempt: 1 });

  // @ts-expect-error the link's client rejects an input field the contract does not have
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1, bogus: true });
  // @ts-expect-error and a wrong field type
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 'deep' });

  const handle = await client.reviewStrategy.SendMessage({
    strategyId: 'a',
    depth: 1,
  });
  expectTypeOf(handle.state).toEqualTypeOf<'TASK_STATE_SUBMITTED'>();
}

/**
 * Contributed context is typed, not merely present: were it `any`, the reads
 * below would compile and the unknown fields would too.
 */
export const laterMiddlewareSeesTypedLease = base
  .use(withLease)
  .use(async ({ context, next }) => {
    expectTypeOf(context.lease).toEqualTypeOf<{
      holder: string;
      generation: number;
    }>();
    // @ts-expect-error a field no middleware contributed
    void context.lease.tenant;
    return next();
  });

export const handlerSeesTypedContext =
  withAudit.reviewStrategy.SendMessage.handler(async ({ context }) => {
    expectTypeOf(context.audit).toEqualTypeOf<{ leaseHolder: string }>();
    expectTypeOf(context.idempotencyKey).toEqualTypeOf<string>();
    // @ts-expect-error a field no middleware contributed
    void context.audit.startedAt;
    return {
      taskId: 'task',
      contextId: 'context',
      state: 'TASK_STATE_SUBMITTED' as const,
    };
  });
