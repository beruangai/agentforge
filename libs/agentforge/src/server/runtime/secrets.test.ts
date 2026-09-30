import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { SECRETS_VARIABLE } from '#core/secrets.ts';
import { requireSecrets, resolveDeclaredSecrets } from './secrets.ts';

const TOKEN_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:token';

function readerOf(values: Record<string, string | undefined>) {
  return {
    send: vi.fn(async (command: GetSecretValueCommand) => ({
      SecretString: values[command.input.SecretId ?? ''],
    })),
  };
}

describe('resolveDeclaredSecrets', () => {
  it('reads each declared secret into the environment variable it names', async () => {
    const environment: NodeJS.ProcessEnv = {
      [SECRETS_VARIABLE]: JSON.stringify({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ARN,
      }),
    };
    await resolveDeclaredSecrets(
      environment,
      readerOf({ [TOKEN_ARN]: 'the-token' }) as never,
    );
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('the-token');
  });

  it('reads nothing when nothing is declared', async () => {
    const reader = readerOf({});
    await resolveDeclaredSecrets({}, reader as never);
    expect(reader.send).not.toHaveBeenCalled();
  });

  it('refuses to replace a variable already set', async () => {
    await expect(
      resolveDeclaredSecrets(
        {
          [SECRETS_VARIABLE]: JSON.stringify({
            CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ARN,
          }),
          CLAUDE_CODE_OAUTH_TOKEN: 'already',
        },
        readerOf({ [TOKEN_ARN]: 'the-token' }) as never,
      ),
    ).rejects.toThrow(/already set/);
  });

  it('refuses a secret with no string value', async () => {
    await expect(
      resolveDeclaredSecrets(
        {
          [SECRETS_VARIABLE]: JSON.stringify({
            CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ARN,
          }),
        },
        readerOf({}) as never,
      ),
    ).rejects.toThrow(/no string value/);
  });
});

describe('requireSecrets', () => {
  it("passes when AgentForge's and every declared secret are set", () => {
    expect(() =>
      requireSecrets(['KATA_API_KEY'], {
        CLAUDE_CODE_OAUTH_TOKEN: 'the-token',
        KATA_API_KEY: 'the-key',
      }),
    ).not.toThrow();
  });

  it("names every secret that is unset or empty, AgentForge's included", () => {
    expect(() =>
      requireSecrets(['KATA_API_KEY', 'KATA_API_KEY'], { KATA_API_KEY: '' }),
    ).toThrow(
      'the agent requires secrets that are not set: CLAUDE_CODE_OAUTH_TOKEN, KATA_API_KEY',
    );
  });
});
