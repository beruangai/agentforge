import { randomUUIDv7 } from 'node:crypto';
import {
  type BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { z } from 'zod';
import { type FixtureEnvelope, FixtureTaskMetadataSchema } from './envelope.ts';

const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});

export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** The container answered, with a JSON-RPC result or a JSON-RPC error. */
export interface DeliveredInvocation {
  readonly delivered: true;
  readonly startedAt: number;
  readonly latencyMilliseconds: number;
  readonly body: JsonRpcResponse;
}

/**
 * `InvokeAgentRuntime` itself failed. AgentCore returns a real HTTP status —
 * and wraps any non-2xx container response as HTTP 424 `-32055 "Runtime client
 * error"` — carrying a JSON-RPC error body the SDK attaches to the exception.
 */
export interface RefusedInvocation {
  readonly delivered: false;
  readonly startedAt: number;
  readonly latencyMilliseconds: number;
  readonly httpStatusCode: number | undefined;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly jsonRpcError: JsonRpcError | undefined;
}

export type Invocation = DeliveredInvocation | RefusedInvocation;

export interface JsonRpcInvocationRequest {
  readonly agentRuntimeArn: string;
  readonly runtimeSessionId: string;
  readonly method: string;
  readonly params: unknown;
  /**
   * Sends `A2A-Version: 1.0`, added before SigV4 signs so it is signed and not
   * dropped. Without it a strict 1.0 container refuses the call (ADR 0014).
   */
  readonly a2aVersionHeader: boolean;
}

/**
 * One JSON-RPC call through `InvokeAgentRuntime`, timed. A refusal by the
 * platform is returned, not thrown, because several findings ARE refusals; a
 * failure that never reached AgentCore throws.
 *
 * `contentType: 'application/json'` is not optional in practice. AgentCore
 * forwards the caller's content type unchanged, and this SDK defaults to
 * `application/octet-stream`, which the A2A SDK's `jsonRpcHandler` rejects —
 * surfacing to the caller as an opaque HTTP 424 that names neither the header
 * nor the cause.
 */
export async function invokeJsonRpc(
  client: BedrockAgentCoreClient,
  request: JsonRpcInvocationRequest,
): Promise<Invocation> {
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: request.agentRuntimeArn,
    runtimeSessionId: request.runtimeSessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUIDv7(),
        method: request.method,
        params: request.params,
      }),
    ),
  });
  if (request.a2aVersionHeader) {
    command.middlewareStack.add(
      (next) => async (args) => {
        const httpRequest: unknown = args.request;
        if (!hasHeaders(httpRequest)) {
          throw new Error(
            'the build step carried no HTTP request to add A2A-Version to',
          );
        }
        httpRequest.headers['A2A-Version'] = '1.0';
        return next(args);
      },
      { step: 'build', name: 'agentforgeIntegA2aVersionHeader' },
    );
  }

  const startedAt = Date.now();
  try {
    const response = await client.send(command);
    if (response.response === undefined) {
      throw new Error(`${request.method}: InvokeAgentRuntime returned no body`);
    }
    const text = await response.response.transformToString();
    const latencyMilliseconds = Date.now() - startedAt;
    const parsed = JsonRpcResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(
        `${request.method}: the container's answer is not JSON-RPC: ${text.slice(0, 500)}`,
      );
    }
    return {
      delivered: true,
      startedAt,
      latencyMilliseconds,
      body: parsed.data,
    };
  } catch (error) {
    if (!(error instanceof Error) || !('$metadata' in error)) throw error;
    const metadata: unknown = error.$metadata;
    const httpStatusCode =
      typeof metadata === 'object' &&
      metadata !== null &&
      'httpStatusCode' in metadata &&
      typeof metadata.httpStatusCode === 'number'
        ? metadata.httpStatusCode
        : undefined;
    const attached = JsonRpcErrorSchema.safeParse(
      'error' in error ? error.error : undefined,
    );
    return {
      delivered: false,
      startedAt,
      latencyMilliseconds: Date.now() - startedAt,
      httpStatusCode,
      errorName: error.name,
      errorMessage: error.message,
      jsonRpcError: attached.success ? attached.data : undefined,
    };
  }
}

function hasHeaders(
  value: unknown,
): value is { headers: Record<string, string> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'headers' in value &&
    typeof value.headers === 'object' &&
    value.headers !== null
  );
}

const FixtureTaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: z.object({ state: z.string() }),
  metadata: FixtureTaskMetadataSchema,
});

export type FixtureTask = z.infer<typeof FixtureTaskSchema>;

/** The 1.0 wire shape of a message carrying the envelope as one data part. */
export function sendMessageParams(envelope: FixtureEnvelope): unknown {
  return {
    message: {
      messageId: randomUUIDv7(),
      role: 'ROLE_USER',
      contextId: randomUUIDv7(),
      parts: [{ data: envelope }],
    },
    configuration: { returnImmediately: true },
  };
}

/**
 * A2A 1.0 over `InvokeAgentRuntime`, against a runtime on the 1.0-only
 * profile: `A2A-Version: 1.0` on every call and the protobuf RPC names
 * `SendMessage`, `GetTask`, `CancelTask`.
 */
export class A2aOverAgentCore {
  constructor(
    private readonly client: BedrockAgentCoreClient,
    readonly agentRuntimeArn: string,
  ) {}

  invoke(
    runtimeSessionId: string,
    method: 'SendMessage' | 'GetTask' | 'CancelTask',
    params: unknown,
  ): Promise<Invocation> {
    return invokeJsonRpc(this.client, {
      agentRuntimeArn: this.agentRuntimeArn,
      runtimeSessionId,
      method,
      params,
      a2aVersionHeader: true,
    });
  }

  /**
   * Starts a task and returns it. Asserts the negotiated version it got back,
   * because AgentCore reports a refused version as an opaque 424
   * indistinguishable from a crash (ADR 0014).
   */
  async SendMessage(
    runtimeSessionId: string,
    envelope: FixtureEnvelope,
  ): Promise<{ invocation: DeliveredInvocation; task: FixtureTask }> {
    const invocation = await this.invoke(
      runtimeSessionId,
      'SendMessage',
      sendMessageParams(envelope),
    );
    const task = taskFrom(invocation, 'SendMessage');
    if (task.metadata.negotiatedVersion !== '1.0') {
      throw new Error(
        `SendMessage negotiated A2A ${task.metadata.negotiatedVersion}, not 1.0 — is A2A-Version on the runtime's request header allowlist?`,
      );
    }
    return { invocation: delivered(invocation, 'SendMessage'), task };
  }

  GetTask(runtimeSessionId: string, taskId: string): Promise<Invocation> {
    return this.invoke(runtimeSessionId, 'GetTask', { id: taskId });
  }

  CancelTask(runtimeSessionId: string, taskId: string): Promise<Invocation> {
    return this.invoke(runtimeSessionId, 'CancelTask', { id: taskId });
  }
}

/**
 * The task an invocation returned, or a throw saying why there is none. A 1.0
 * `SendMessage` answers `{ task }`; `GetTask` and `CancelTask` answer the task.
 */
export function taskFrom(invocation: Invocation, method: string): FixtureTask {
  const { body } = delivered(invocation, method);
  if (body.error !== undefined) {
    throw new Error(
      `${method} answered JSON-RPC error ${body.error.code}: ${body.error.message}`,
    );
  }
  const result: unknown =
    method === 'SendMessage' &&
    typeof body.result === 'object' &&
    body.result !== null &&
    'task' in body.result
      ? body.result.task
      : body.result;
  return FixtureTaskSchema.parse(result);
}

export function delivered(
  invocation: Invocation,
  method: string,
): DeliveredInvocation {
  if (!invocation.delivered) {
    throw new Error(
      `${method} was refused: HTTP ${invocation.httpStatusCode} ${invocation.errorName}: ${invocation.errorMessage}` +
        (invocation.jsonRpcError === undefined
          ? ''
          : ` (JSON-RPC ${invocation.jsonRpcError.code} ${invocation.jsonRpcError.message})`),
    );
  }
  return invocation;
}
