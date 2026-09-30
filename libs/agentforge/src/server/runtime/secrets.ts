import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import {
  REQUIRED_SECRETS,
  SECRETS_VARIABLE,
  SecretNameSchema,
} from '#core/secrets.ts';

const DeclaredSecretsSchema = z.record(SecretNameSchema, z.string().min(1));

type SecretReader = Pick<SecretsManagerClient, 'send'>;

/**
 * Reads each declared secret into the environment, before any task starts,
 * so task processes inherit it. Nothing declared, nothing read; a secret that
 * cannot be read, or would replace a variable already set, fails the request
 * that prepared the container.
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

/**
 * Fails unless every secret the agent requires is set: AgentForge's own and
 * each its layers declare, `required`. Run once the declared secrets are
 * resolved, so it holds wherever the value came from — a deployment's
 * secret, or the environment a local container is served with.
 */
export function requireSecrets(
  required: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const missing = [...REQUIRED_SECRETS, ...required].filter(
    (name) => environment[name] === undefined || environment[name] === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `the agent requires secrets that are not set: ${[...new Set(missing)].join(', ')}`,
    );
  }
}
