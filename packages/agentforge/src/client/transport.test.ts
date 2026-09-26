import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentForgeRequestError, agentCoreTransport } from './transport.ts';

const send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send = send;
  },
  InvokeAgentRuntimeCommand: class {
    middlewareStack = { add: vi.fn() };
  },
}));

/** What the AWS SDK throws for AgentCore's JSON-RPC errors: unmodelled, the body spread onto it. */
function agentCoreError(httpStatusCode: number, code: number): Error {
  return Object.assign(new Error('UnknownError'), {
    name: 'Unknown',
    $metadata: { httpStatusCode },
    jsonrpc: '2.0',
    id: null,
    error: { code, message: `refused with ${code}` },
  });
}

function answered(result: unknown) {
  return {
    response: {
      transformToString: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    },
  };
}

const transport = agentCoreTransport({
  agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-2:0:runtime/agent',
  region: 'us-east-2',
});

describe('agentCoreTransport', () => {
  beforeEach(() => {
    send.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("repeats a call AgentCore refuses while it creates the session's container", async () => {
    send
      .mockRejectedValueOnce(agentCoreError(409, -32054))
      .mockRejectedValueOnce(agentCoreError(424, -32055))
      .mockResolvedValueOnce(answered({ id: 'task' }));
    const call = transport.call('GetTask', { id: 'task' }, 'session');
    await vi.runAllTimersAsync();
    await expect(call).resolves.toEqual({ id: 'task' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('throws the refusal once the budget is spent', async () => {
    send.mockRejectedValue(agentCoreError(409, -32054));
    const call = transport.call('SendMessage', {}, 'session');
    const settled = expect(call).rejects.toMatchObject({
      name: 'AgentForgeRequestError',
      method: 'SendMessage',
      code: -32054,
    });
    await vi.runAllTimersAsync();
    await settled;
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("throws any other AgentCore error at once, with AgentCore's code", async () => {
    send.mockRejectedValueOnce(agentCoreError(404, -32051));
    await expect(
      transport.call('GetTask', { id: 'task' }, 'session'),
    ).rejects.toBeInstanceOf(AgentForgeRequestError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws an error that is not AgentCore’s as it came', async () => {
    const denied = Object.assign(new Error('denied'), {
      name: 'AccessDeniedException',
    });
    send.mockRejectedValueOnce(denied);
    await expect(
      transport.call('GetTask', { id: 'task' }, 'session'),
    ).rejects.toBe(denied);
  });
});
