import { z } from 'zod';
import { agentCoreTransport, type Transport } from './transport.ts';

/** Where a deployment's runtime configuration lives in AppConfig. */
export interface RuntimeConfigSource {
  /** The deployment's `RuntimeConfigApplicationId`. */
  readonly applicationId: string;
  /** The AppConfig environment; `default`, as `@aws/nx-plugin` deploys it. */
  readonly environment?: string;
  readonly region?: string;
}

/** The namespace `@aws/nx-plugin` registers AgentCore runtimes under, one configuration profile. */
const AGENTCORE_NAMESPACE = 'agentcore';
const DEFAULT_ENVIRONMENT = 'default';

/** The `agentcore` namespace; only `agentRuntimes` is read, each entry checked per agent. */
const AgentCoreNamespaceSchema = z.looseObject({
  agentRuntimes: z.record(z.string(), z.unknown()).optional(),
});
/** One runtime `@aws/nx-plugin` registered: `{ arn, ... }`. */
const AgentRuntimeEntrySchema = z.looseObject({ arn: z.string().min(1) });

/** The `agentcore` namespace's document, read once through AppConfig Data. */
async function readAgentCoreNamespace(
  source: RuntimeConfigSource,
  environment: string,
  described: string,
): Promise<z.infer<typeof AgentCoreNamespaceSchema>> {
  const sdk = await import('@aws-sdk/client-appconfigdata');
  const client = new sdk.AppConfigDataClient(
    source.region === undefined ? {} : { region: source.region },
  );
  const session = await client.send(
    new sdk.StartConfigurationSessionCommand({
      ApplicationIdentifier: source.applicationId,
      EnvironmentIdentifier: environment,
      ConfigurationProfileIdentifier: AGENTCORE_NAMESPACE,
    }),
  );
  if (session.InitialConfigurationToken === undefined) {
    throw new Error(`${described}: AppConfig returned no configuration token`);
  }
  const latest = await client.send(
    new sdk.GetLatestConfigurationCommand({
      ConfigurationToken: session.InitialConfigurationToken,
    }),
  );
  const text =
    latest.Configuration === undefined
      ? ''
      : new TextDecoder().decode(latest.Configuration);
  if (text.trim() === '') {
    throw new Error(`${described} is empty`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${described} is not JSON`, { cause: error });
  }
  const parsed = AgentCoreNamespaceSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`${described} is not an agentcore namespace`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * One `agentCoreTransport` per agent, each found by the key its runtime is
 * registered under in the deployment's runtime configuration (`agentcore`
 * namespace, `agentRuntimes`), read once. Every agent must resolve: any that
 * does not is named with its key and nothing is returned.
 */
export async function agentCoreTransportsFromRuntimeConfig<
  Agent extends string,
>(
  keys: Readonly<Record<Agent, string>>,
  source: RuntimeConfigSource,
): Promise<Record<Agent, Transport>> {
  const environment = source.environment ?? DEFAULT_ENVIRONMENT;
  const described = `runtime configuration ${source.applicationId}/${environment}/${AGENTCORE_NAMESPACE}`;
  const namespace = await readAgentCoreNamespace(
    source,
    environment,
    described,
  );
  const agentRuntimes = namespace.agentRuntimes ?? {};
  const transports: Partial<Record<Agent, Transport>> = {};
  const unresolved: string[] = [];
  for (const [agent, key] of Object.entries(keys) as [Agent, string][]) {
    if (!Object.hasOwn(agentRuntimes, key)) {
      unresolved.push(`${agent} (key ${key}: not registered)`);
      continue;
    }
    const entry = AgentRuntimeEntrySchema.safeParse(agentRuntimes[key]);
    if (!entry.success) {
      unresolved.push(`${agent} (key ${key}: no arn)`);
      continue;
    }
    transports[agent] = agentCoreTransport({
      agentRuntimeArn: entry.data.arn,
      ...(source.region === undefined ? {} : { region: source.region }),
    });
  }
  if (unresolved.length > 0) {
    throw new Error(
      `${described} resolves no agent runtime for: ${unresolved.join(', ')}`,
    );
  }
  return transports as Record<Agent, Transport>;
}
