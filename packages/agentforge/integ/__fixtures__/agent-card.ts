import type { AgentCard, AgentInterface } from '@a2a-js/sdk';

export const FIXTURE_AGENT_NAME = 'agentforge-integ-fixture';

/**
 * The 1.0 card, plus the three top-level fields a 0.3 card carried
 * (`protocolVersion`, `url`, `preferredTransport`), which the spike's card
 * declared and `GetAgentCard` was observed against. `url` is one of the fields
 * AgentCore rewrites.
 */
export type FixtureAgentCard = AgentCard & {
  protocolVersion: string;
  url: string;
  preferredTransport: string;
};

/**
 * §I — with `a2aOneZeroOnly` the card declares ONE interface, 1.0, and the server
 * turns `legacyCompat` off: AgentForge's configuration (ADR 0014). Without it
 * the card declares 1.0 and 0.3, and an absent `A2A-Version` negotiates 0.3 —
 * the permissive configuration, kept only as the control that shows what the
 * strict one refuses.
 */
export function buildFixtureAgentCard(options: {
  url: string;
  a2aOneZeroOnly: boolean;
}): FixtureAgentCard {
  const interfaceFor = (protocolVersion: string): AgentInterface => ({
    url: options.url,
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion,
  });
  return {
    protocolVersion: '1.0',
    url: options.url,
    preferredTransport: 'JSONRPC',
    name: FIXTURE_AGENT_NAME,
    description: 'AgentCore contract fixture: a task is a timer',
    version: '0.0.0',
    provider: undefined,
    supportedInterfaces: options.a2aOneZeroOnly
      ? [interfaceFor('1.0')]
      : [interfaceFor('1.0'), interfaceFor('0.3')],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'timer',
        name: 'timer',
        description: 'sleeps for a requested duration',
        tags: ['fixture'],
        examples: [],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
