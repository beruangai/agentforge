import { randomUUIDv7 } from 'node:crypto';
import { runtimeSessionHeader } from '#core/contract/envelope.ts';

export type TaskMethod = 'SendMessage' | 'GetTask' | 'CancelTask';

/** How the client reaches an agent: one JSON-RPC call, routed by runtime session. */
export interface Transport {
  call(
    method: TaskMethod,
    params: unknown,
    runtimeSessionId: string,
  ): Promise<unknown>;
}

/** A JSON-RPC error the agent answered with. */
export class AgentForgeRequestError extends Error {
  constructor(
    readonly method: TaskMethod,
    readonly code: number | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `${method}: ${code === undefined ? '' : `${code} `}${message}`,
      options,
    );
    this.name = 'AgentForgeRequestError';
  }
}

function requestBody(method: TaskMethod, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: randomUUIDv7(), method, params });
}

function resultOf(method: TaskMethod, text: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new AgentForgeRequestError(
      method,
      undefined,
      `not JSON-RPC: ${text.slice(0, 300)}`,
      {
        cause: error,
      },
    );
  }
  const response = body as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (response.error !== undefined) {
    throw new AgentForgeRequestError(
      method,
      response.error.code,
      response.error.message ?? 'no message',
    );
  }
  if (!('result' in response)) {
    throw new AgentForgeRequestError(
      method,
      undefined,
      `no result: ${text.slice(0, 300)}`,
    );
  }
  return response.result;
}

/** An agent reached directly over HTTP — a container running locally. */
export function localTransport(url: string): Transport {
  return {
    async call(method, params, runtimeSessionId) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          [runtimeSessionHeader]: runtimeSessionId,
        },
        body: requestBody(method, params),
      });
      return resultOf(method, await response.text());
    },
  };
}

/**
 * An agent deployed on AgentCore, reached through `InvokeAgentRuntime`,
 * signed with the caller's own AWS credentials (§REQ708). The AgentCore SDK
 * is an optional peer, loaded on first use.
 */
export function agentCoreTransport(options: {
  readonly agentRuntimeArn: string;
  readonly region?: string;
  readonly qualifier?: string;
}): Transport {
  let client:
    | Promise<
        import('@aws-sdk/client-bedrock-agentcore').BedrockAgentCoreClient
      >
    | undefined;
  return {
    async call(method, params, runtimeSessionId) {
      const sdk = await import('@aws-sdk/client-bedrock-agentcore');
      client ??= Promise.resolve(
        new sdk.BedrockAgentCoreClient(
          options.region === undefined ? {} : { region: options.region },
        ),
      );
      const command = new sdk.InvokeAgentRuntimeCommand({
        agentRuntimeArn: options.agentRuntimeArn,
        runtimeSessionId,
        ...(options.qualifier === undefined
          ? {}
          : { qualifier: options.qualifier }),
        // AgentCore forwards the caller's content type; the A2A handler refuses anything else.
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(requestBody(method, params)),
      });
      // Added before signing, so it is signed and forwarded (ADR 0014).
      command.middlewareStack.add(
        (next) => async (args) => {
          const request = args.request as { headers?: Record<string, string> };
          if (request.headers === undefined) {
            throw new Error(
              'InvokeAgentRuntime built no HTTP request to add A2A-Version to',
            );
          }
          request.headers['A2A-Version'] = '1.0';
          return next(args);
        },
        { step: 'build', name: 'agentforgeA2aVersionHeader' },
      );
      const response = await (await client).send(command);
      if (response.response === undefined) {
        throw new AgentForgeRequestError(
          method,
          undefined,
          'InvokeAgentRuntime returned no body',
        );
      }
      return resultOf(method, await response.response.transformToString());
    },
  };
}
