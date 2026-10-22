import { z } from 'zod';

/**
 * Set by the `AgentRuntime` construct and read by the server: the secrets a
 * deployment declares, as a JSON object from the environment variable each
 * becomes to the secret's ARN.
 */
export const SECRETS_VARIABLE = 'AGENTFORGE_SECRETS';

/** The environment variable a secret becomes. */
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
