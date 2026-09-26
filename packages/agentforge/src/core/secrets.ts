/**
 * Set by the `AgentRuntime` construct and read by the server: the secrets a
 * deployment declares, as a JSON object from the environment variable each
 * becomes to the secret's ARN (§REQ705). A stopgap until AgentCore Identity
 * holds them.
 */
export const SECRETS_VARIABLE = 'AGENTFORGE_SECRETS';
