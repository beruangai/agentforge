import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { SECRETS_VARIABLE } from '#core/secrets.ts';

const DeclaredSecretsSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  z.string().min(1),
);

type SecretReader = Pick<SecretsManagerClient, 'send'>;

/**
 * Reads each declared secret into the environment, before any task starts,
 * so task processes inherit it. Nothing declared, nothing read; a secret that
 * cannot be read, or would replace a variable already set, stops the server.
 */
export async function resolveDeclaredSecrets(
  environment: NodeJS.ProcessEnv = process.env,
  reader: SecretReader = new SecretsManagerClient({}),
): Promise<void> {
  const declared = environment[SECRETS_VARIABLE];
  if (declared === undefined || declared === '') return;
  const secrets = DeclaredSecretsSchema.parse(JSON.parse(declared));
  for (const [name, secretArn] of Object.entries(secrets)) {
    if (environment[name] !== undefined) {
      throw new Error(
        `${name} is already set; a declared secret does not replace it`,
      );
    }
    const { SecretString } = await reader.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (SecretString === undefined || SecretString === '') {
      throw new Error(`the secret for ${name} holds no string value`);
    }
    environment[name] = SecretString;
  }
}
