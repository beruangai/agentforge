/**
 * The split, named with A2A's own verbs, and what each call requires.
 *
 *  1. NO INVENTED VERBS. The wire is A2A, so the derived procedures are
 *     `SendMessage`, `GetTask` and `CancelTask` verbatim; a translation layer
 *     over terms that already exist buys ambiguity and nothing else.
 *
 *  2. `CancelTask` IS ROOT-LEVEL. It needs a task id and a runtime session id
 *     to reach the right container; both are the caller's (ADR 0007) and
 *     neither comes from a contract.
 *
 *  3. `runtimeSessionId` is transport routing — the AgentCore session header —
 *     so it rides in the CLIENT CONTEXT beside the idempotency key. But the two
 *     are not required on the same calls: an idempotency key means nothing on
 *     a poll or a cancel, and demanding one there would make a caller invent a
 *     value.
 *
 * The question: `RouterContractClient` distributes ONE context type over every
 * leaf. Can AgentForge still require the idempotency key on `SendMessage`
 * alone, without demanding it on the others?
 */
import { randomUUIDv7 } from 'node:crypto';
import { type ClientLink, createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { implement } from '@orpc/server';
import { callByPath } from './in-memory-hop.ts';
import { contract, type ReviewStrategyTask } from './task-contract.ts';

/** Routing. Required on EVERY call, because every call reaches a container. */
export type Routed = { runtimeSessionId: string };
/** Starting work. Only a start is idempotent, so only a start needs the key. */
export type Starting = Routed & { idempotencyKey: string };

/**
 * The client type AgentForge vends. `RouterContractClient` applies one context
 * to a whole router, so it is applied PER LEAF instead — which is the point of
 * AgentForge owning this type rather than a consumer writing it.
 */
export type AgentForgeClient = {
  [Namespace in keyof Omit<typeof contract, 'CancelTask'>]: {
    SendMessage: ContractRouterClient<
      (typeof contract)[Namespace]['SendMessage'],
      Starting
    >;
    GetTask: ContractRouterClient<
      (typeof contract)[Namespace]['GetTask'],
      Routed
    >;
  };
} & {
  CancelTask: ContractRouterClient<(typeof contract)['CancelTask'], Routed>;
};

export interface LinkObservation {
  path: string;
  /** What becomes the AgentCore session header. */
  runtimeSessionId: string;
  idempotencyKey: string | undefined;
}

export function createAgentForgeClient() {
  const os = implement(contract).$context<{ callerId: string }>();
  const reviewStrategyTasks = new Map<string, ReviewStrategyTask>();
  const cancelledTaskIds: string[] = [];

  const router = os.router({
    reviewStrategy: {
      SendMessage: os.reviewStrategy.SendMessage.handler(async () => {
        const taskId = randomUUIDv7();
        reviewStrategyTasks.set(taskId, {
          state: 'WORKING',
          startedAt: '2026-09-23T00:00:00.000Z',
        });
        return {
          taskId,
          contextId: randomUUIDv7(),
          state: 'SUBMITTED' as const,
        };
      }),
      GetTask: os.reviewStrategy.GetTask.handler(async ({ input }) => {
        const task = reviewStrategyTasks.get(input.taskId);
        if (task === undefined) {
          throw new Error(`no such task: ${input.taskId}`);
        }
        return task;
      }),
    },
    summariseCorpus: {
      SendMessage: os.summariseCorpus.SendMessage.handler(async () => ({
        taskId: randomUUIDv7(),
        contextId: randomUUIDv7(),
        state: 'SUBMITTED' as const,
      })),
      GetTask: os.summariseCorpus.GetTask.handler(async () => ({
        state: 'SUBMITTED' as const,
      })),
    },
    CancelTask: os.CancelTask.handler(async ({ input }) => {
      cancelledTaskIds.push(input.taskId);
      return { state: 'CANCELLED' as const };
    }),
  });

  const seenByLink: LinkObservation[] = [];
  /** The link takes the LOOSER context; the client's own type is the gate. */
  const link: ClientLink<Routed & { idempotencyKey?: string }> = {
    async call(path, input, options) {
      seenByLink.push({
        path: path.join('.'),
        runtimeSessionId: options.context.runtimeSessionId,
        idempotencyKey: options.context.idempotencyKey,
      });
      return callByPath(router, path, input, {
        context: { callerId: 'temporal-worker' },
      });
    },
  };

  const client: AgentForgeClient = createORPCClient(link);
  return { client, reviewStrategyTasks, cancelledTaskIds, seenByLink };
}
