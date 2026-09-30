import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import type { NativeConnectionOptions } from '@temporalio/worker';

/** Hosts an API key is never sent to: a key there is a mistake, not a local server's need. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

/** How the worker reaches agents, as `AGENTFORGE_AGENTS` names it. */
export type AgentsSetting =
  | { readonly kind: 'local' }
  | { readonly kind: 'runtime-config'; readonly applicationId: string };

const RUNTIME_CONFIG_PREFIX = 'runtime-config:';

/**
 * `AGENTFORGE_AGENTS`: `local` — each agent in its local container — or
 * `runtime-config:<applicationId>` — each on AgentCore, resolved from the
 * deployment's runtime configuration. Unset or anything else throws.
 */
export function agentsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AgentsSetting {
  const setting = environment.AGENTFORGE_AGENTS;
  if (setting === 'local') return { kind: 'local' };
  if (setting?.startsWith(RUNTIME_CONFIG_PREFIX)) {
    const applicationId = setting.slice(RUNTIME_CONFIG_PREFIX.length);
    if (applicationId !== '') return { kind: 'runtime-config', applicationId };
  }
  throw new Error(
    setting === undefined
      ? 'AGENTFORGE_AGENTS is unset: set `local` or `runtime-config:<applicationId>`'
      : `AGENTFORGE_AGENTS is '${setting}': set \`local\` or \`runtime-config:<applicationId>\``,
  );
}

/**
 * The Temporal connection from the environment alone — `TEMPORAL_ADDRESS`,
 * `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` and envconfig's other variables —
 * with no profile file read, so none can change a connection silently. TLS
 * follows the key. Throws, naming each, on an unset address or namespace,
 * which envconfig does not check, and on a key with a local address.
 */
export function temporalConnectConfig(
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly connectionOptions: NativeConnectionOptions;
  readonly namespace: string;
} {
  const { connectionOptions, namespace } = loadClientConnectConfig({
    disableFile: true,
    overrideEnvVars: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const problems = [
    ...(connectionOptions.address ? [] : ['TEMPORAL_ADDRESS is unset']),
    ...(namespace ? [] : ['TEMPORAL_NAMESPACE is unset']),
  ];
  const address = connectionOptions.address;
  if (
    connectionOptions.apiKey !== undefined &&
    address !== undefined &&
    LOCAL_HOSTS.has(hostOf(address))
  ) {
    problems.push(
      `TEMPORAL_API_KEY is set with the local address ${address}: a local server takes no key`,
    );
  }
  if (problems.length > 0 || namespace === undefined) {
    throw new Error(`the Temporal connection: ${problems.join('; ')}`);
  }
  return { connectionOptions, namespace };
}

/** `host:port`, `[::1]:port` or a bare host, to its host. */
function hostOf(address: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(address);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  if (address.split(':').length > 2) return address; // an unbracketed IPv6 address
  return address.split(':')[0] ?? address;
}

/** A client for starting workflows, connected as `temporalConnectConfig` reads the environment. */
export async function connectTemporalClient(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Client> {
  const { connectionOptions, namespace } = temporalConnectConfig(environment);
  return new Client({
    connection: await Connection.connect(connectionOptions),
    namespace,
  });
}
