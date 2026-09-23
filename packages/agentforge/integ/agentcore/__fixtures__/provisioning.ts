/// <reference lib="esnext.disposable" />
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  GetWorkloadIdentityCommand,
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
import { vi } from 'vitest';
import { verifyAgentCoreAccess } from './access.ts';
import {
  type AwsEnvironment,
  integTag,
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
 * The platform findings — a busy container, one container per session, the
 * stop and its grace period, the lease — do not depend on the protocol
 * version, so they are asserted against what AgentForge will actually run.
 */
export const a2a10OnlyProfile: RuntimeProfile = {
  environmentVariables: { A2A_STRICT_10: '1' },
  requestHeaderAllowlist: ['A2A-Version'],
};

/**
 * The configuration the request header allowlist was measured on: 1.0 and
 * 0.3 both declared, so an absent `A2A-Version` negotiates 0.3 instead of
 * being refused, plus a custom header to show the allowlist is a filter and
 * not an `A2A-Version` special case.
 */
export const permissiveProbeHeadersProfile: RuntimeProfile = {
  environmentVariables: {},
  requestHeaderAllowlist: ['A2A-Version', 'X-Agentforge-Probe'],
};

export interface AgentCoreClients {
  readonly control: BedrockAgentCoreControlClient;
  readonly data: BedrockAgentCoreClient;
  readonly logs: CloudWatchLogsClient;
  readonly dynamo: DynamoDBClient;
  readonly ecr: ECRClient;
}

export function createAgentCoreClients(region: string): AgentCoreClients {
  return {
    control: new BedrockAgentCoreControlClient({ region }),
    data: new BedrockAgentCoreClient({ region }),
    logs: new CloudWatchLogsClient({ region }),
    dynamo: new DynamoDBClient({ region }),
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
): Promise<PreparedFixtureImage> {
  const environment = await resolveAwsEnvironment();
  await verifyAgentCoreAccess(environment);
  const clients = createAgentCoreClients(environment.region);
  const names = resourceNamesFor(purpose);
  const repositoryUri = await createImageRepository(
    resources,
    clients,
    names.repositoryName,
  );
  const image = await buildAndPushFixtureImage(environment, repositoryUri);
  return { environment, clients, names, image };
}

export interface FixtureRuntime extends PreparedFixtureImage {
  readonly runtime: CreatedAgentRuntime;
  /** Present when the runtime was provisioned with a lease table. */
  readonly leaseTableName: string | undefined;
}

/**
 * Everything one test file needs: the access check, an image, optionally a
 * lease table, and a runtime that has reported READY. Deleted in `afterAll`
 * through `releaseResources`.
 */
export async function provisionFixtureRuntime(
  resources: AsyncDisposableStack,
  options: {
    purpose: string;
    profile: RuntimeProfile;
    leaseTable: boolean;
  },
): Promise<FixtureRuntime> {
  const prepared = await prepareFixtureImage(resources, options.purpose);
  const leaseTableName = options.leaseTable
    ? await createLeaseTable(
        resources,
        prepared.clients,
        prepared.names.leaseTableName,
      )
    : undefined;
  const runtime = await createAgentRuntime(resources, prepared, {
    profile: options.profile,
  });
  await waitForAgentRuntimeReady(prepared.clients, runtime);
  return { ...prepared, runtime, leaseTableName };
}

async function createImageRepository(
  resources: AsyncDisposableStack,
  clients: AgentCoreClients,
  repositoryName: string,
): Promise<string> {
  const created = await clients.ecr.send(
    new CreateRepositoryCommand({
      repositoryName,
      tags: [{ Key: integTag.key, Value: integTag.value }],
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
 * On-demand DynamoDB in the runtime's region, keyed by `leaseId`. The name
 * starts `agentforge-integ-`, which is all the execution role may touch.
 */
async function createLeaseTable(
  resources: AsyncDisposableStack,
  clients: AgentCoreClients,
  tableName: string,
): Promise<string> {
  await clients.dynamo.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'leaseId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'leaseId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      Tags: [{ Key: integTag.key, Value: integTag.value }],
    }),
  );
  resources.defer(async () => {
    try {
      await clients.dynamo.send(
        new DeleteTableCommand({ TableName: tableName }),
      );
      await waitUntilTableNotExists(
        { client: clients.dynamo, maxWaitTime: 300 },
        { TableName: tableName },
      );
    } catch (error) {
      throw new Error(`DynamoDB table ${tableName}: ${describeError(error)}`, {
        cause: error,
      });
    }
  });
  await waitUntilTableExists(
    { client: clients.dynamo, maxWaitTime: 120 },
    { TableName: tableName },
  );
  return tableName;
}

export interface CreatedAgentRuntime {
  readonly agentRuntimeArn: string;
  readonly agentRuntimeId: string;
  readonly agentRuntimeName: string;
  /** What `CreateAgentRuntime` reported, before any polling. */
  readonly statusAtCreation: string;
  /** Local clock, immediately before and after `CreateAgentRuntime`. */
  readonly createIssuedAt: number;
  readonly createReturnedAt: number;
  readonly workloadIdentityName: string | undefined;
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
  const createIssuedAt = Date.now();
  const created = await clients.control.send(
    new CreateAgentRuntimeCommand({
      agentRuntimeName: names.agentRuntimeName,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      roleArn: environment.executionRoleArn,
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
      tags: { [integTag.key]: integTag.value },
    }),
  );
  const createReturnedAt = Date.now();
  const { agentRuntimeArn, agentRuntimeId, status } = created;
  if (agentRuntimeArn === undefined || agentRuntimeId === undefined) {
    throw new Error(
      `CreateAgentRuntime ${names.agentRuntimeName} returned no ARN or id; look for it by name and delete it`,
    );
  }
  const runtime: CreatedAgentRuntime = {
    agentRuntimeArn,
    agentRuntimeId,
    agentRuntimeName: names.agentRuntimeName,
    statusAtCreation: String(status),
    createIssuedAt,
    createReturnedAt,
    workloadIdentityName: created.workloadIdentityDetails?.workloadIdentityArn
      ?.split('/')
      .at(-1),
  };
  // Deferred in this order so release runs the runtime first, then its logs.
  resources.defer(() => deleteRuntimeLogGroups(clients, runtime));
  resources.defer(() => deleteAgentRuntimeUntilGone(clients, runtime));
  return runtime;
}

/** Generous: a cold image build dominates, and the runtime reaches READY in ~10 s. */
export const provisioningTimeoutMilliseconds = 900_000;
/** A runtime sits in DELETING for about five minutes; its workload identity follows. */
export const teardownTimeoutMilliseconds = 1_500_000;

const failedStatuses = new Set([
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
]);

export async function waitForAgentRuntimeReady(
  clients: AgentCoreClients,
  runtime: CreatedAgentRuntime,
): Promise<void> {
  let lastStatus = runtime.statusAtCreation;
  try {
    await vi.waitUntil(
      async () => {
        const current = await clients.control.send(
          new GetAgentRuntimeCommand({
            agentRuntimeId: runtime.agentRuntimeId,
          }),
        );
        lastStatus = String(current.status);
        if (failedStatuses.has(lastStatus)) {
          throw new Error(
            `runtime ${runtime.agentRuntimeArn} is ${lastStatus}: ${current.failureReason ?? 'no failureReason given'}`,
          );
        }
        return lastStatus === 'READY';
      },
      { timeout: 300_000, interval: 3_000 },
    );
  } catch (error) {
    throw new Error(
      `runtime ${runtime.agentRuntimeArn} did not become READY (last status ${lastStatus}): ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * `DeleteAgentRuntime` returns at once but the runtime sits in DELETING for
 * about five minutes (docs/research/agentcore-runtime-observed.md), so a
 * teardown that returned on the call would leave it outliving the run. This
 * waits until it is gone, and until the workload identity AgentCore minted
 * alongside it is gone too — that one cannot be deleted by the caller.
 */
async function deleteAgentRuntimeUntilGone(
  clients: AgentCoreClients,
  runtime: CreatedAgentRuntime,
): Promise<void> {
  let lastStatus = 'not yet read';
  try {
    // A test may already have deleted it — the provisioning window test does.
    // Gone is the goal, and a runtime already DELETING is not deleted twice.
    const current = await clients.control
      .send(
        new GetAgentRuntimeCommand({ agentRuntimeId: runtime.agentRuntimeId }),
      )
      .catch((error: unknown) => {
        if (isResourceNotFound(error)) return undefined;
        throw error;
      });
    lastStatus = current === undefined ? 'gone' : String(current.status);
    if (current !== undefined && lastStatus !== 'DELETING') {
      await clients.control.send(
        new DeleteAgentRuntimeCommand({
          agentRuntimeId: runtime.agentRuntimeId,
        }),
      );
    }
    await vi.waitUntil(
      async () => {
        try {
          const current = await clients.control.send(
            new GetAgentRuntimeCommand({
              agentRuntimeId: runtime.agentRuntimeId,
            }),
          );
          lastStatus = String(current.status);
          if (lastStatus === 'DELETE_FAILED') {
            throw new Error(
              `DELETE_FAILED: ${current.failureReason ?? 'no failureReason given'}`,
            );
          }
          return false;
        } catch (error) {
          if (isResourceNotFound(error)) return true;
          throw error;
        }
      },
      { timeout: 900_000, interval: 10_000 },
    );
    const workloadIdentityName = runtime.workloadIdentityName;
    if (workloadIdentityName !== undefined) {
      lastStatus = `runtime gone; workload identity ${workloadIdentityName} still listed`;
      await vi.waitUntil(
        async () => {
          try {
            await clients.control.send(
              new GetWorkloadIdentityCommand({ name: workloadIdentityName }),
            );
            return false;
          } catch (error) {
            if (isResourceNotFound(error)) return true;
            throw error;
          }
        },
        { timeout: 300_000, interval: 10_000 },
      );
    }
  } catch (error) {
    throw new Error(
      `runtime ${runtime.agentRuntimeArn} (last status ${lastStatus}): ${describeError(error)}`,
      { cause: error },
    );
  }
}

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

function isResourceNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
