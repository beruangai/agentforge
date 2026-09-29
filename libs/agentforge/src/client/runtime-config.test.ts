import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCoreTransportsFromRuntimeConfig } from './runtime-config.ts';

const appConfigSend = vi.fn();
const appConfigClients: unknown[] = [];
const agentCoreSend = vi.fn();
const invoked: { agentRuntimeArn: string }[] = [];

vi.mock('@aws-sdk/client-appconfigdata', () => ({
  AppConfigDataClient: class {
    send = appConfigSend;
    constructor(configuration: unknown) {
      appConfigClients.push(configuration);
    }
  },
  StartConfigurationSessionCommand: class {
    readonly name = 'StartConfigurationSession';
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetLatestConfigurationCommand: class {
    readonly name = 'GetLatestConfiguration';
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send = agentCoreSend;
  },
  InvokeAgentRuntimeCommand: class {
    middlewareStack = { add: vi.fn() };
    constructor(input: { agentRuntimeArn: string }) {
      invoked.push(input);
    }
  },
}));

const REVIEWER_ARN = 'arn:aws:bedrock-agentcore:us-east-2:0:runtime/reviewer';
const FIXER_ARN = 'arn:aws:bedrock-agentcore:us-east-2:0:runtime/fixer';
const KEYS = { reviewer: 'Reviewer', fixer: 'Fixer' } as const;

/** AppConfig Data answering a session, then `document` as the configuration. */
function configured(document: unknown): void {
  appConfigSend
    .mockResolvedValueOnce({ InitialConfigurationToken: 'token' })
    .mockResolvedValueOnce({
      Configuration: new TextEncoder().encode(JSON.stringify(document)),
    });
}

describe('agentCoreTransportsFromRuntimeConfig', () => {
  beforeEach(() => {
    appConfigSend.mockReset();
    agentCoreSend.mockReset();
    appConfigClients.length = 0;
    invoked.length = 0;
  });

  it('reads the agentcore namespace once, from the default environment', async () => {
    configured({
      agentRuntimes: {
        Reviewer: { arn: REVIEWER_ARN },
        Fixer: { arn: FIXER_ARN },
      },
    });
    await agentCoreTransportsFromRuntimeConfig(KEYS, {
      applicationId: 'application',
      region: 'us-east-2',
    });
    expect(appConfigClients).toEqual([{ region: 'us-east-2' }]);
    expect(appConfigSend.mock.calls.map(([command]) => command)).toEqual([
      {
        name: 'StartConfigurationSession',
        input: {
          ApplicationIdentifier: 'application',
          EnvironmentIdentifier: 'default',
          ConfigurationProfileIdentifier: 'agentcore',
        },
      },
      {
        name: 'GetLatestConfiguration',
        input: { ConfigurationToken: 'token' },
      },
    ]);
  });

  it('builds one transport per agent, for the runtime its key names', async () => {
    configured({
      agentRuntimes: {
        Reviewer: { arn: REVIEWER_ARN, session: { bucketName: 'bucket' } },
        Fixer: { arn: FIXER_ARN },
      },
    });
    const transports = await agentCoreTransportsFromRuntimeConfig(KEYS, {
      applicationId: 'application',
      environment: 'staging',
    });
    expect(appConfigSend.mock.calls[0]?.[0]).toMatchObject({
      input: { EnvironmentIdentifier: 'staging' },
    });
    const answered = {
      response: {
        transformToString: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
      },
    };
    agentCoreSend
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce(answered);
    await transports.fixer.call('GetTask', {}, 'session');
    await transports.reviewer.call('GetTask', {}, 'session');
    expect(invoked.map(({ agentRuntimeArn }) => agentRuntimeArn)).toEqual([
      FIXER_ARN,
      REVIEWER_ARN,
    ]);
  });

  it('throws naming every agent that does not resolve, and returns none', async () => {
    configured({
      agentRuntimes: { Reviewer: { session: {} }, Other: { arn: FIXER_ARN } },
    });
    const failed = agentCoreTransportsFromRuntimeConfig(KEYS, {
      applicationId: 'application',
    });
    await expect(failed).rejects.toThrow(
      'runtime configuration application/default/agentcore resolves no agent runtime for: reviewer (key Reviewer: no arn), fixer (key Fixer: not registered)',
    );
    expect(invoked).toEqual([]);
  });

  it('throws when no runtime is registered at all', async () => {
    configured({ gateways: {} });
    await expect(
      agentCoreTransportsFromRuntimeConfig(KEYS, {
        applicationId: 'application',
      }),
    ).rejects.toThrow(/reviewer \(key Reviewer: not registered\)/);
  });

  it('throws on an empty configuration', async () => {
    appConfigSend
      .mockResolvedValueOnce({ InitialConfigurationToken: 'token' })
      .mockResolvedValueOnce({ Configuration: new Uint8Array() });
    await expect(
      agentCoreTransportsFromRuntimeConfig(KEYS, {
        applicationId: 'application',
      }),
    ).rejects.toThrow(
      'runtime configuration application/default/agentcore is empty',
    );
  });

  it('throws on a configuration that is not JSON', async () => {
    appConfigSend
      .mockResolvedValueOnce({ InitialConfigurationToken: 'token' })
      .mockResolvedValueOnce({
        Configuration: new TextEncoder().encode('agentRuntimes:'),
      });
    await expect(
      agentCoreTransportsFromRuntimeConfig(KEYS, {
        applicationId: 'application',
      }),
    ).rejects.toThrow(
      'runtime configuration application/default/agentcore is not JSON',
    );
  });

  it("rejects with AppConfig's own error when the read is refused", async () => {
    const denied = Object.assign(new Error('denied'), {
      name: 'AccessDeniedException',
    });
    appConfigSend.mockRejectedValueOnce(denied);
    await expect(
      agentCoreTransportsFromRuntimeConfig(KEYS, {
        applicationId: 'application',
      }),
    ).rejects.toBe(denied);
  });
});
