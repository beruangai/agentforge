import type { CredentialConfig } from '../runner/types.js';

const DEFAULT_CREDENTIAL_PROXY_URL = 'http://host.docker.internal:3128';

/**
 * Generate environment variables for credential injection based on the configured mode.
 */
export function resolveCredentialEnv(
  config?: CredentialConfig,
  /** ExecuteConfig.env — used for validation in env mode */
  execEnv?: Record<string, string>,
): Record<string, string> {
  if (!config) return {};

  switch (config.mode) {
    case 'env':
      // In env mode, the API key or OAuth token should already be in the env map.
      // Claude Code supports both ANTHROPIC_API_KEY (pay-per-use) and
      // CLAUDE_CODE_OAUTH_TOKEN (Anthropic subscription auth).
      if (
        execEnv &&
        !execEnv['ANTHROPIC_API_KEY'] &&
        !execEnv['CLAUDE_CODE_OAUTH_TOKEN']
      ) {
        console.warn(
          '[agentforge] CredentialConfig mode=env but neither ANTHROPIC_API_KEY nor ' +
            'CLAUDE_CODE_OAUTH_TOKEN is in env map. Claude Code will fail without credentials.',
        );
      }
      return {};

    case 'onecli':
      // OneCLI proxy mode: external credential management, API keys never enter container.
      if (!config.proxyUrl) {
        throw new Error('CredentialConfig: onecli mode requires proxyUrl');
      }
      return {
        ANTHROPIC_AUTH_MODE: 'onecli',
        ANTHROPIC_PROXY_URL: config.proxyUrl,
        ...(config.agent ? { ANTHROPIC_AGENT_ID: config.agent } : {}),
      };

    case 'proxy':
      // Native credential proxy: reads from host .env, injects via local proxy.
      // The proxy runs on the host and is accessible from inside the container
      // at host.docker.internal.
      return {
        ANTHROPIC_AUTH_MODE: 'proxy',
        ANTHROPIC_CREDENTIAL_PROXY_URL:
          config.credentialProxyUrl ?? DEFAULT_CREDENTIAL_PROXY_URL,
        ...(config.agent ? { ANTHROPIC_AGENT_ID: config.agent } : {}),
      };

    default:
      throw new Error(
        `Unknown credential mode: ${(config as CredentialConfig).mode}`,
      );
  }
}
