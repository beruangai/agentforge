/**
 * Cancellation reaches middleware and handler, and a `ClientLink` types the
 * per-call client context with no cast — recorded in
 * docs/research/procedure-framework.md.
 *
 * Cancellation is out of band for AgentForge: a caller's signal cannot travel
 * with an `InvokeAgentRuntime` call, so the link must map a caller's abort onto
 * the separate `CancelTask` invocation. Accepting a signal and dropping it
 * would be a silent failure.
 */
import { describe, expect, it } from 'vitest';
import { createCancellableClient } from './__fixtures__/cancellation-and-typed-link.ts';

describe('client context through a typed link', () => {
  it('hands the link the caller’s idempotency key beside the input', async () => {
    const { client, seenByLink } = createCancellableClient();

    const handle = await client.SendMessage(
      { strategyId: 'alpha' },
      { context: { idempotencyKey: 'idempotency-key-strategy-alpha' } },
    );

    expect(handle).toStrictEqual({
      taskId: 'task-alpha',
      contextId: 'context-alpha',
      state: 'TASK_STATE_SUBMITTED',
    });
    expect(seenByLink).toMatchObject([
      {
        path: ['SendMessage'],
        idempotencyKey: 'idempotency-key-strategy-alpha',
      },
    ]);
  });
});

describe('cancellation', () => {
  it('reaches middleware and handler as one signal, and a running procedure returns promptly', async () => {
    const { client, observations, seenByLink } = createCancellableClient();
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error('CancelTask arrived')), 60);

    const started = performance.now();
    const outcome = await client.RunForMilliseconds(
      { milliseconds: 5_000 },
      {
        context: { idempotencyKey: 'idempotency-key-cancelled-run' },
        signal: caller.signal,
      },
    );
    const elapsedMilliseconds = performance.now() - started;

    expect(seenByLink).toHaveLength(1);
    expect(seenByLink[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(observations.middlewareSignals).toHaveLength(1);
    expect(observations.abortedAtMiddlewareEntry).toStrictEqual([false]);
    expect(observations.handlerSignals).toHaveLength(1);
    expect(observations.handlerSignals[0]).toBe(
      observations.middlewareSignals[0],
    );
    expect(observations.handlerContextSignals[0]).toBe(
      observations.middlewareSignals[0],
    );
    expect(observations.abortedWhenHandlerReturned).toStrictEqual([true]);
    expect(outcome).toStrictEqual({ finished: false });
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it('lets an uncancelled run finish — the check can fail', async () => {
    const { client, observations } = createCancellableClient();

    const outcome = await client.RunForMilliseconds(
      { milliseconds: 20 },
      { context: { idempotencyKey: 'idempotency-key-uncancelled-run' } },
    );

    expect(outcome).toStrictEqual({ finished: true });
    expect(observations.abortedWhenHandlerReturned).toStrictEqual([false]);
  });
});
