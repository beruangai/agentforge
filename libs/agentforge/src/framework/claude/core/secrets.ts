/**
 * The secrets the `claude` framework requires of every agent, by the
 * environment variable each becomes: the operator's subscription token
 * (§REQ705). A project and each of its agents declare their own beside these,
 * in their layer's `secrets.ts`.
 */
export const REQUIRED_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;
export type RequiredSecret = (typeof REQUIRED_SECRETS)[number];
