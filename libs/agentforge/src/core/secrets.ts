import { z } from 'zod';

/**
 * Set by the `AgentRuntime` construct and read by the server: the secrets a
 * deployment declares, as a JSON object from the environment variable each
 * becomes to the secret's ARN (§REQ705).
 */
export const SECRETS_VARIABLE = 'AGENTFORGE_SECRETS';

/**
 * The secrets AgentForge requires of every agent, by the environment variable
 * each becomes: the operator's subscription token (§REQ705). A project and
 * each of its agents declare their own beside these, in their layer's
 * `secrets.ts`.
 */
export const REQUIRED_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;
export type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

/** The environment variable a secret becomes. */
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
