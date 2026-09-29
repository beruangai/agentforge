/**
 * AgentForge's base image as the package's `image` target builds it, local to
 * this machine — what a consumer's image is built `FROM`. The `integ` target
 * depends on `image`, so Nx builds it before any test runs.
 */
export const AGENTFORGE_BASE_IMAGE = 'agentforge/a2a-claude:local';
