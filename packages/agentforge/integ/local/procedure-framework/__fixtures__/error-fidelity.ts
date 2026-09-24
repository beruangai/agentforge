/**
 * What survives of an error, in process and across a transport that
 * serialises the way `InvokeAgentRuntime` does. Lossy errors across a
 * transport were the stated pain point with tRPC.
 */
import {
  type ClientLink,
  createORPCClient,
  createORPCErrorFromJson,
  isORPCErrorJson,
  ORPCError,
  RPCSerializer,
} from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { z } from 'zod';
import { type errorContract, errorRouter } from './error-throwing-router.ts';
import { callByPath } from './in-memory-hop.ts';

/** What a container can put on the wire about a raw failure. */
const rawErrorBody = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string(),
});

type WireResponse = { ok: true; body: unknown } | { ok: false; body: unknown };

/**
 * A link whose transport serialises. Whether the original stack crosses is the
 * link's choice, which is what `carryStack: false` demonstrates.
 */
export function createSerialisingClient(options: { carryStack: boolean }) {
  const serializer = new RPCSerializer();

  async function invokeAgentRuntime(
    path: readonly string[],
    input: unknown,
  ): Promise<string> {
    try {
      const output = await callByPath(errorRouter, path, input, {
        context: {},
      });
      return JSON.stringify({ ok: true, body: serializer.serialize(output) });
    } catch (error) {
      if (error instanceof ORPCError) {
        return JSON.stringify({
          ok: false,
          body: serializer.serialize(error.toJSON()),
        });
      }
      if (error instanceof Error) {
        return JSON.stringify({
          ok: false,
          body: serializer.serialize({
            name: error.name,
            message: error.message,
            stack: error.stack,
          }),
        });
      }
      throw new Error('the procedure threw something that is not an Error', {
        cause: error,
      });
    }
  }

  const link: ClientLink<Record<never, never>> = {
    async call(path, input) {
      const response: WireResponse = JSON.parse(
        await invokeAgentRuntime(path, input),
      );
      const body = serializer.deserialize(response.body);
      if (response.ok) {
        return body;
      }
      if (isORPCErrorJson(body)) {
        throw createORPCErrorFromJson(body);
      }
      const raw = rawErrorBody.parse(body);
      const error = new Error(raw.message);
      error.name = raw.name;
      if (options.carryStack) {
        error.stack = raw.stack;
      }
      throw error;
    },
  };

  const client: ContractRouterClient<
    typeof errorContract,
    Record<never, never>
  > = createORPCClient(link);
  return client;
}
