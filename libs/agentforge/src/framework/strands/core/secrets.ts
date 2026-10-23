/**
 * The secrets the `strands` framework requires of every agent, by the
 * environment variable each becomes: the Anthropic API key, bounded by the
 * provider account's spend limit (§REQ714, ADR 0022). A project and each of
 * its agents declare their own beside these, in their layer's `secrets.ts`.
 */
export const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY'] as const;
export type RequiredSecret = (typeof REQUIRED_SECRETS)[number];
