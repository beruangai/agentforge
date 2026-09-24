/**
 * Cancellation, and a link that needs no cast.
 *
 *  A. CLIENT CONTEXT. `ClientLink<TClientContext>` types what a caller must
 *     supply per call, separately from the input. The idempotency key needs
 *     exactly this: it is not part of any procedure's input — no procedure
 *     should declare it — but no start may go without one. If the compiler
 *     enforces that, the key cannot be forgotten.
 *
 *  B. CANCELLATION. oRPC threads an `AbortSignal` to middleware and handler.
 *     AgentForge cancels out of band — a `CancelTask` arrives as its own
 *     invocation, not as a dropped connection — so what matters is whether a
 *     signal AgentForge raises itself is visible to a running procedure.
 */
import { setTimeout } from 'node:timers/promises';
import { type ClientLink, createORPCClient } from '@orpc/client';
import { type ContractRouterClient, oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { z } from 'zod';
import { callByPath } from './in-memory-hop.ts';
import { taskHandle } from './task-contract.ts';

export const cancellationContract = {
  SendMessage: oc
    .input(z.object({ strategyId: z.string() }))
    .output(taskHandle),
  RunForMilliseconds: oc
    .input(z.object({ milliseconds: z.number() }))
    .output(z.object({ finished: z.boolean() })),
};

/** What every caller must supply per call, beside the input. */
export type CallerContext = { idempotencyKey: string };

export interface CancellationObservations {
  middlewareSignals: AbortSignal[];
  abortedAtMiddlewareEntry: boolean[];
  handlerSignals: AbortSignal[];
  /** The signal the middleware put in the typed context, as the handler read it. */
  handlerContextSignals: AbortSignal[];
  abortedWhenHandlerReturned: boolean[];
}

/** The caller context and abort signal one call handed the link. */
export interface CallerContextAndSignalObservation {
  path: string[];
  idempotencyKey: string;
  signal: AbortSignal | undefined;
}

export function createCancellableClient() {
  const observations: CancellationObservations = {
    middlewareSignals: [],
    abortedAtMiddlewareEntry: [],
    handlerSignals: [],
    handlerContextSignals: [],
    abortedWhenHandlerReturned: [],
  };

  const base = implement(cancellationContract).$context<{ callerId: string }>();

  /** A house middleware that sees the signal, as a lease renewer would. */
  const os = base.use(async ({ signal, next }) => {
    if (signal === undefined) {
      throw new Error('no signal reached the middleware');
    }
    observations.middlewareSignals.push(signal);
    observations.abortedAtMiddlewareEntry.push(signal.aborted);
    return next({ context: { deadline: { signal } } });
  });

  // Assembled on `base`: `.router()` on `os` would prepend the middleware to
  // procedures that already carry it, and run it twice per call.
  const router = base.router({
    SendMessage: os.SendMessage.handler(async ({ input }) => ({
      taskId: `task-${input.strategyId}`,
      contextId: `context-${input.strategyId}`,
      state: 'TASK_STATE_SUBMITTED' as const,
    })),
    RunForMilliseconds: os.RunForMilliseconds.handler(
      async ({ input, signal, context }) => {
        if (signal === undefined) {
          throw new Error('no signal reached the handler');
        }
        observations.handlerSignals.push(signal);
        observations.handlerContextSignals.push(context.deadline.signal);
        // A real procedure races its work against the signal. No polling.
        const finished = await setTimeout(input.milliseconds, true, {
          signal,
        }).catch((error: unknown) => {
          if (signal.aborted) {
            return false;
          }
          throw error;
        });
        observations.abortedWhenHandlerReturned.push(signal.aborted);
        return { finished };
      },
    ),
  });

  const seenByLink: CallerContextAndSignalObservation[] = [];
  const link: ClientLink<CallerContext> = {
    async call(path, input, options) {
      // Both are typed off ClientLink — no cast, no `any`.
      const idempotencyKey: string = options.context.idempotencyKey;
      const signal: AbortSignal | undefined = options.signal;
      seenByLink.push({ path: [...path], idempotencyKey, signal });

      // The caller's signal cannot travel with an InvokeAgentRuntime call, so
      // the container is given one of its own that follows it. Dropping the
      // caller's would be a silent failure, so the link maps it — standing in
      // for the out-of-band CancelTask.
      const containerSignal = AbortSignal.any(
        signal === undefined ? [] : [signal],
      );
      return callByPath(router, path, input, {
        context: { callerId: 'temporal-worker' },
        signal: containerSignal,
      });
    },
  };

  const client: ContractRouterClient<
    typeof cancellationContract,
    CallerContext
  > = createORPCClient(link);
  return { client, observations, seenByLink };
}
