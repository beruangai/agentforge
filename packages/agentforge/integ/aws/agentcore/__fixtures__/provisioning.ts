import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  paginateDescribeLogGroups,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';
import { integTag } from '../../__fixtures__/aws-account.ts';
import { verifyAgentCoreAccess } from './access.ts';
import {
  type AgentRuntimeReference,
  agentRuntimeDeletionTimeoutMilliseconds,
  agentRuntimeReferenceFrom,
  agentRuntimeStatusTimeoutMilliseconds,
  deleteAgentRuntimeUntilGone,
  describeError,
  waitForAgentRuntimeReady,
} from './agent-runtime-status.ts';
import {
  type AwsEnvironment,
  type ResourceNames,
  resolveAwsEnvironment,
  resourceNamesFor,
} from './aws-environment.ts';
import { buildAndPushFixtureImage, type PushedImage } from './image.ts';
import { runtimeLogGroupNamePrefix } from './runtime-logs.ts';

/**
 * How the fixture container is configured on AgentCore. Each test file
 * provisions a runtime with the profile its findings were measured on.
 */
export interface RuntimeProfile {
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly requestHeaderAllowlist: readonly string[];
}

/**
 * AgentForge's own configuration (ADR 0014): the card declares one 1.0
 * interface, `legacyCompat` is off, and the runtime allowlists `A2A-Version`.
 * The platform findings — a busy container, the provisioning window, the stop,
 * its grace period and an outcome written inside it — do not depend on the
 * protocol version, so they are asserted against what AgentForge will
 * actually run.
 */
export const a2aOneZeroOnlyProfile: RuntimeProfile = {
  environmentVariables: { A2A_ONE_ZERO_ONLY: '1' },
  requestHeaderAllowlist: ['A2A-Version'],
};

export interface AgentCoreClients {
  readonly control: BedrockAgentCoreControlClient;
  readonly data: BedrockAgentCoreClient;
  readonly logs: CloudWatchLogsClient;
  readonly dynamoDB: DynamoDBClient;
  readonly ecr: ECRClient;
}

export function createAgentCoreClients(region: string): AgentCoreClients {
  return {
    control: new BedrockAgentCoreControlClient({ region }),
    data: new BedrockAgentCoreClient({ region }),
    logs: new CloudWatchLogsClient({ region }),
    dynamoDB: new DynamoDBClient({ region }),
    ecr: new ECRClient({ region }),
  };
}

export interface PreparedFixtureImage {
  readonly environment: AwsEnvironment;
  readonly clients: AgentCoreClients;
  readonly names: ResourceNames;
  readonly image: PushedImage;
}

/**
 * The access check, an ECR repository, and the fixture image pushed to it —
 * everything before a runtime. Each resource is deferred onto `resources` the
 * moment it exists.
 */
export async function prepareFixtureImage(
  resources: AsyncDisposableStack,
  purpose: string,
  buildImage: (
    environment: AwsEnvironment,
    repositoryUri: string,
  ) => Promise<PushedImage> = buildAndPushFixtureImage,
): Promise<PreparedFixtureImage> {
  const environment = await resolveAwsEnvironment();
  await verifyAgentCoreAccess(resources, environment);
  const clients = createAgentCoreClients(environment.region);
  const names = resourceNamesFor(purpose);
  const repositoryUri = await createImageRepository(
    resources,
    clients,
    names.repositoryName,
  );
  const image = await buildImage(environment, repositoryUri);
  return { environment, clients, names, image };
}

export interface FixtureRuntime extends PreparedFixtureImage {
  readonly runtime: CreatedAgentRuntime;
  /** Present when the runtime was provisioned with an outcome table. */
  readonly outcomeTableName: string | undefined;
}

/**
 * Everything one test file needs: the access check, an image, optionally an
 * outcome table, and a runtime that has reported READY. Deleted in `afterAll`
 * through `releaseResources`.
 */
export async function provisionFixtureRuntime(
  resources: AsyncDisposableStack,
  options: {
    purpose: string;
    profile: RuntimeProfile;
    outcomeTable: boolean;
  },
): Promise<FixtureRuntime> {
  const prepared = await prepareFixtureImage(resources, options.purpose);
  const outcomeTableName = options.outcomeTable
    ? await createOutcomeTable(
        resources,
        prepared.clients,
        prepared.names.outcomeTableName,
      )
    : undefined;
  const runtime = await createAgentRuntime(resources, prepared, {
    profile: options.profile,
  });
  await waitForAgentRuntimeReady(prepared.clients.control, runtime);
  return { ...prepared, runtime, outcomeTableName };
}

async function createImageRepository(
  resources: AsyncDisposableStack,
  clients: AgentCoreClients,
  repositoryName: string,
): Promise<string> {
  const created = await clients.ecr.send(
    new CreateRepositoryCommand({
      repositoryName,
      tags: [integTag],
    }),
  );
  resources.defer(async () => {
    try {
      await clients.ecr.send(
        new DeleteRepositoryCommand({ repositoryName, force: true }),
      );
    } catch (error) {
      throw new Error(
        `ECR repository ${repositoryName}: ${describeError(error)}`,
        {
          cause: error,
        },
      );
    }
  });
  const repositoryUri = created.repository?.repositoryUri;
  if (repositoryUri === undefined) {
    throw new Error(
      `CreateRepository ${repositoryName} returned no repositoryUri`,
    );
  }
  return repositoryUri;
}

/**
 * On-demand DynamoDB in the runtime's region, keyed by `outcomeKey`, for an
 * outcome the container writes from its SIGTERM handler. The name starts
 * `agentforge-integ-`, which is all the execution role may touch.
 */
async function createOutcomeTable(
  resources: AsyncDisposableStack,
  clients: AgentCoreClients,
  tableName: string,
): Promise<string> {
  await clients.dynamoDB.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'outcomeKey', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'outcomeKey', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      Tags: [integTag],
    }),
  );
  resources.defer(async () => {
    try {
      await clients.dynamoDB.send(
        new DeleteTableCommand({ TableName: tableName }),
      );
      await waitUntilTableNotExists(
        { client: clients.dynamoDB, maxWaitTime: 300 },
        { TableName: tableName },
      );
    } catch (error) {
      throw new Error(`DynamoDB table ${tableName}: ${describeError(error)}`, {
        cause: error,
      });
    }
  });
  await waitUntilTableExists(
    { client: clients.dynamoDB, maxWaitTime: 120 },
    { TableName: tableName },
  );
  return tableName;
}

export interface CreatedAgentRuntime extends AgentRuntimeReference {
  readonly agentRuntimeName: string;
  /** What `CreateAgentRuntime` reported, before any polling. */
  readonly statusAtCreation: string;
  /** Local clock, immediately after `CreateAgentRuntime` returned. */
  readonly createReturnedAt: number;
}

/**
 * Creates the runtime and defers its deletion. Returns as soon as
 * `CreateAgentRuntime` does — the provisioning window test measures from that
 * instant — so a caller that needs it serving calls `waitForAgentRuntimeReady`.
 */
export async function createAgentRuntime(
  resources: AsyncDisposableStack,
  prepared: PreparedFixtureImage,
  options: { profile: RuntimeProfile },
): Promise<CreatedAgentRuntime> {
  const { clients, environment, names, image } = prepared;
  const created = await clients.control.send(
    new CreateAgentRuntimeCommand({
      agentRuntimeName: names.agentRuntimeName,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      roleArn: environment.executionRoleArn,
      // What AgentForge runs on (docs/research/agentcore-runtime.md §Platform
      // version V2): every container restored from one snapshot, and a create
      // that takes minutes.
      platformVersion: 'V2',
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: { serverProtocol: 'A2A' },
      requestHeaderConfiguration: {
        requestHeaderAllowlist: [...options.profile.requestHeaderAllowlist],
      },
      // Omitted rather than sent empty when the profile sets none.
      environmentVariables:
        Object.keys(options.profile.environmentVariables).length > 0
          ? { ...options.profile.environmentVariables }
          : undefined,
      tags: { [integTag.Key]: integTag.Value },
    }),
  );
  const createReturnedAt = Date.now();
  const runtime: CreatedAgentRuntime = {
    ...agentRuntimeReferenceFrom(created, names.agentRuntimeName),
    agentRuntimeName: names.agentRuntimeName,
    statusAtCreation: String(created.status),
    createReturnedAt,
  };
  // Deferred in this order so release runs the runtime first, then its logs.
  resources.defer(() => deleteRuntimeLogGroups(clients, runtime));
  resources.defer(() => deleteAgentRuntimeUntilGone(clients.control, runtime));
  return runtime;
}

/**
 * A cold image build and the access check, then a V2 create, which takes
 * minutes before READY.
 */
export const provisioningTimeoutMilliseconds =
  600_000 + agentRuntimeStatusTimeoutMilliseconds;
/** The runtime's deletion dominates; its log groups, repository and table follow. */
export const teardownTimeoutMilliseconds =
  agentRuntimeDeletionTimeoutMilliseconds + 600_000;

/** AgentCore creates the runtime's log groups; they go when it does. */
async function deleteRuntimeLogGroups(
  clients: AgentCoreClients,
  runtime: CreatedAgentRuntime,
): Promise<void> {
  const prefix = runtimeLogGroupNamePrefix(runtime.agentRuntimeId);
  try {
    for await (const page of paginateDescribeLogGroups(
      { client: clients.logs },
      { logGroupNamePrefix: prefix },
    )) {
      for (const { logGroupName } of page.logGroups ?? []) {
        if (logGroupName === undefined) {
          throw new Error('DescribeLogGroups returned a group with no name');
        }
        await clients.logs.send(new DeleteLogGroupCommand({ logGroupName }));
      }
    }
  } catch (error) {
    throw new Error(`log groups ${prefix}*: ${describeError(error)}`, {
      cause: error,
    });
  }
}
