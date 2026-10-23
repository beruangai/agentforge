/** The subscription's credential, which `claude` runs authenticate with (§REQ714). */
export const OAUTH_TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The credentials the CLI prefers to the OAuth token, and in headless mode
 * always uses when present ([authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)).
 */
export const OUTRANKING_CREDENTIAL_VARIABLES = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * The CLI's environment, with the subscription's credential the one it uses:
 * while the OAuth token is present, a credential that outranks it — another
 * framework's API key in the same environment — is left out of what the CLI
 * inherits, as is the same value passed through the procedure's env
 * (`{ ...process.env }`, as the SDK suggests); a value of the procedure's own
 * is refused rather than dropped.
 */
export function subscriptionEnv(
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  procedureEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const env = { ...inheritedEnv, ...procedureEnv };
  if (!env[OAUTH_TOKEN_VARIABLE]) return env;
  for (const variable of OUTRANKING_CREDENTIAL_VARIABLES) {
    const own = procedureEnv[variable];
    if (own !== undefined && own !== inheritedEnv[variable]) {
      throw new Error(
        `the run sets ${variable} in its env, which the CLI would use instead of the subscription's ${OAUTH_TOKEN_VARIABLE}`,
      );
    }
    delete env[variable];
  }
  return env;
}
