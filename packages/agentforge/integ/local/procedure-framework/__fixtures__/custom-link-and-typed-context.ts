/**
 * Two questions about oRPC for AgentForge:
 *
 *  1. A CUSTOM LINK. AgentForge's transport is A2A over `InvokeAgentRuntime`,
 *     not HTTP. If a link can carry a typed call over an arbitrary transport,
 *     the client is ours without adapting AgentCore into HTTP. The hop here is
 *     deliberately AgentCore-shaped — one JSON payload in, one JSON payload out
 *     — which is all `InvokeAgentRuntime` is.
 *
 *  2. TYPED CONTEXT THAT MIDDLEWARE CONTRIBUTES TO. The capability preserved
 *     from tRPC and the thing that is expensive to retrofit: a reusable
 *     middleware adds a field, and every later middleware and the handler see
 *     it typed, without the procedure declaring it.
 */
import { type ClientLink, createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { callByPath } from './in-memory-hop.ts';
import { contract, type ReviewStrategyTask } from './task-contract.ts';

export const linkContract = { reviewStrategy: contract.reviewStrategy };

/** What the container knows when it answers — not what a caller supplies. */
export interface ContainerContext {
  idempotencyKey: string;
  attempt: number;
}

export const base = implement(linkContract).$context<ContainerContext>();

/** A reusable house middleware. It resolves something and adds it, typed. */
export const withLease = base.middleware(async ({ context, next }) =>
  next({
    context: {
      lease: {
        holder: `container-${context.attempt}`,
        generation: context.attempt,
      },
    },
  }),
);

/**
 * Defined on the chain that already has `withLease`, so whether `context.lease`
 * is typed here is the whole claim. No cast: if the type does not flow, this
 * does not compile.
 */
export const withAudit = base
  .use(withLease)
  .use(async ({ context, next }) =>
    next({ context: { audit: { leaseHolder: context.lease.holder } } }),
  );

export interface HandlerObservation {
  idempotencyKey: string;
  lease: { holder: string; generation: number };
  audit: { leaseHolder: string };
}

/** One call as the link put it on the wire. */
export interface WireEnvelope {
  path: string[];
  input: unknown;
}

export function createLinkedClient(containerContext: ContainerContext) {
  const tasks = new Map<string, ReviewStrategyTask>();
  const handlerObservations: HandlerObservation[] = [];

  // Assembled on `base`, not on `withAudit`: oRPC's `.router()` prepends the
  // builder's middleware to every procedure again, without deduplicating, so
  // assembling on `withAudit` would run each middleware twice per call.
  const router = base.router({
    reviewStrategy: {
      SendMessage: withAudit.reviewStrategy.SendMessage.handler(
        async ({ input, context }) => {
          // Every contributed field must be visible, and typed, here.
          handlerObservations.push({
            idempotencyKey: context.idempotencyKey,
            lease: context.lease,
            audit: context.audit,
          });
          const taskId = `task-${input.strategyId}`;
          tasks.set(taskId, {
            state: 'TASK_STATE_COMPLETED',
            output: {
              verdict: input.depth > 2 ? 'PASS' : 'FAIL',
              score: input.depth * 10,
            },
          });
          return {
            taskId,
            contextId: `context-${taskId}`,
            state: 'TASK_STATE_SUBMITTED' as const,
          };
        },
      ),
      GetTask: withAudit.reviewStrategy.GetTask.handler(async ({ input }) => {
        const task = tasks.get(input.taskId);
        if (task === undefined) {
          throw new Error(`no such task: ${input.taskId}`);
        }
        return task;
      }),
    },
  });

  const wire: WireEnvelope[] = [];
  /** Stands in for InvokeAgentRuntime: one JSON payload in, one JSON payload out. */
  async function invokeAgentRuntime(payload: string): Promise<string> {
    const envelope: WireEnvelope = JSON.parse(payload);
    wire.push(envelope);
    const output = await callByPath(router, envelope.path, envelope.input, {
      context: containerContext,
    });
    return JSON.stringify({ output });
  }

  /** The whole link. This is the seam AgentForge owns. */
  const link: ClientLink<Record<never, never>> = {
    async call(path, input) {
      const response: { output: unknown } = JSON.parse(
        await invokeAgentRuntime(JSON.stringify({ path, input })),
      );
      return response.output;
    },
  };

  // Typed from the contract, over a link that knows nothing about HTTP. If
  // this is not typed, oRPC buys AgentForge nothing a plain function would not.
  const client: ContractRouterClient<
    typeof linkContract,
    Record<never, never>
  > = createORPCClient(link);

  return { client, wire, handlerObservations };
}

/**
 * How many times one call runs a builder's middleware when the router is
 * assembled on the base implementer, as AgentForge assembles it. Assembling on
 * the middlewared builder instead runs it twice — oRPC v2's documented
 * behaviour ("automatic deduplication removed"), recorded in
 * docs/research/procedure-framework.md rather than tested.
 */
export async function countMiddlewareRuns(): Promise<number> {
  let runs = 0;
  const counted = base.use(async ({ next }) => {
    runs += 1;
    return next();
  });
  const router = base.router({
    reviewStrategy: {
      SendMessage: counted.reviewStrategy.SendMessage.handler(async () => ({
        taskId: 'task',
        contextId: 'context',
        state: 'TASK_STATE_SUBMITTED' as const,
      })),
      GetTask: counted.reviewStrategy.GetTask.handler(async () => ({
        state: 'TASK_STATE_SUBMITTED' as const,
      })),
    },
  });
  await createRouterClient(router, {
    context: { idempotencyKey: 'k', attempt: 1 },
  }).reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 });
  return runs;
}
