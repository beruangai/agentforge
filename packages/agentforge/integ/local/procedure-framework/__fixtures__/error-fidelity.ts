/**
 * What oRPC's own error serialisation carries across a transport that
 * serialises the way `InvokeAgentRuntime` does. Lossy errors across a
 * transport were the stated pain point with tRPC.
 *
 * Only an `ORPCError` crosses: `toJSON`, `RPCSerializer`, `isORPCErrorJson`
 * and `createORPCErrorFromJson` are oRPC's, so what arrives is oRPC's doing.
 * How a raw error would cross is the link's own code, not oRPC's, and is not
 * modelled here.
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
import { type errorContract, errorRouter } from './error-throwing-router.ts';
import { callByPath } from './in-memory-hop.ts';

type WireResponse = { ok: true; body: unknown } | { ok: false; body: unknown };

/** A link whose transport serialises every response, error or not. */
export function createSerialisingClient() {
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
      throw new Error(
        'the procedure threw something that is not an ORPCError',
        {
          cause: error,
        },
      );
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
      if (!isORPCErrorJson(body)) {
        throw new Error(
          `the wire carried an error that is not an ORPCError: ${JSON.stringify(body)}`,
        );
      }
      throw createORPCErrorFromJson(body);
    },
  };

  const client: ContractRouterClient<
    typeof errorContract,
    Record<never, never>
  > = createORPCClient(link);
  return client;
}
