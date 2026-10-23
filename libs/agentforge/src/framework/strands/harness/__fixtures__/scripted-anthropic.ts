import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A tool call the scripted model makes. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** One response of the scripted Messages API, in the order requests arrive. */
export type ScriptedStep =
  | { readonly toolCalls: readonly ScriptedToolCall[] }
  | { readonly text: string; readonly stopReason?: 'end_turn' | 'max_tokens' }
  | {
      readonly status: number;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly details?: unknown;
      };
      readonly headers?: Readonly<Record<string, string>>;
    }
  /** Holds the response open until the request is aborted. */
  | { readonly hang: true };

/** A request as the scripted API received it. */
export interface ReceivedRequest {
  readonly system?: unknown;
  readonly messages: readonly {
    readonly role: string;
    readonly content: readonly Record<string, unknown>[];
  }[];
  readonly tools?: readonly { readonly name: string }[];
  readonly tool_choice?: unknown;
  readonly model: string;
}

export interface ScriptedAnthropic {
  /** The client configuration that sends to it, with the SDK's own retries off. */
  readonly clientConfig: { readonly baseURL: string; readonly maxRetries: 0 };
  readonly requests: ReceivedRequest[];
  close(): Promise<void>;
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 3,
};

/** The Messages API, answering each request with the next scripted step over SSE. */
export async function scriptedAnthropic(
  steps: readonly ScriptedStep[],
): Promise<ScriptedAnthropic> {
  const requests: ReceivedRequest[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as ReceivedRequest;
      requests.push(parsed);
      const step = steps[requests.length - 1];
      if (step === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `no step ${requests.length} scripted`,
            },
          }),
        );
        return;
      }
      if ('hang' in step) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        return;
      }
      if ('status' in step) {
        response.writeHead(step.status, {
          'content-type': 'application/json',
          ...step.headers,
        });
        response.end(JSON.stringify({ type: 'error', error: step.error }));
        return;
      }
      const index = requests.length;
      const events: [string, unknown][] = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `msg_${index}`,
              type: 'message',
              role: 'assistant',
              model: parsed.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: USAGE,
            },
          },
        ],
      ];
      if ('toolCalls' in step) {
        step.toolCalls.forEach((call, position) => {
          events.push(
            [
              'content_block_start',
              {
                type: 'content_block_start',
                index: position,
                content_block: {
                  type: 'tool_use',
                  id: `toolu_${index}_${position}`,
                  name: call.name,
                  input: {},
                },
              },
            ],
            [
              'content_block_delta',
              {
                type: 'content_block_delta',
                index: position,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(call.input),
                },
              },
            ],
            [
              'content_block_stop',
              { type: 'content_block_stop', index: position },
            ],
          );
        });
        events.push([
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
        ]);
      } else {
        events.push(
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: step.text },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: {
                stop_reason: step.stopReason ?? 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: 1 },
            },
          ],
        );
      }
      events.push(['message_stop', { type: 'message_stop' }]);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        events
          .map(
            ([event, data]) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(''),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    clientConfig: { baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 },
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The tool results the agent sent back in a request, in order. */
export function toolResults(
  request: ReceivedRequest | undefined,
): { readonly isError: boolean; readonly text: string }[] {
  const last = request?.messages.at(-1);
  return (last?.content ?? [])
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      isError: block.is_error === true,
      text: JSON.stringify(block.content),
    }));
}
