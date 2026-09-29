import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { QueryFunction } from '../kernel.ts';

export interface ScriptedQuery {
  readonly query: QueryFunction;
  readonly calls: { options: Record<string, unknown> }[];
  readonly interrupted: () => boolean;
  readonly closed: () => boolean;
}

/**
 * A stand-in for the SDK's `query()`: reads the first prompt message, then
 * yields the scripted messages. `hang` holds the stream open after them
 * until interrupted, like a turn still running; `crash` throws after them,
 * as a stream that failed.
 */
export function scriptedQuery(
  messages: SDKMessage[],
  behaviour: { hang?: boolean; crash?: Error } = {},
): ScriptedQuery {
  const calls: { options: Record<string, unknown> }[] = [];
  let interrupted = false;
  let closed = false;
  let release: () => void = () => undefined;
  const query = ((parameters: Parameters<QueryFunction>[0]) => {
    calls.push({ options: { ...parameters.options } });
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      const prompt = parameters.prompt;
      if (typeof prompt !== 'string') {
        await prompt[Symbol.asyncIterator]().next();
      }
      for (const message of messages) yield message;
      if (behaviour.crash !== undefined) throw behaviour.crash;
      if (behaviour.hang) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield result({
          subtype: 'error_during_execution',
          terminal_reason: 'aborted_streaming',
        });
      }
    }
    const generator = stream();
    return Object.assign(generator, {
      interrupt: async () => {
        interrupted = true;
        release();
        return undefined;
      },
      close: () => {
        closed = true;
        release();
      },
    });
  }) as unknown as QueryFunction;
  return {
    query,
    calls,
    interrupted: () => interrupted,
    closed: () => closed,
  };
}

export function result(
  fields: Partial<SDKResultMessage> & Record<string, unknown>,
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: '00000000-0000-7000-8000-000000000000',
    session_id: 'session-1',
    ...fields,
  } as unknown as SDKMessage;
}

export function init(sessionId = 'session-1'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: ['StructuredOutput'],
  } as unknown as SDKMessage;
}
