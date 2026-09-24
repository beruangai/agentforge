import { randomUUIDv7 } from 'node:crypto';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { integTag } from '../../__fixtures__/aws-account.ts';
import {
  agentRuntimeReferenceFrom,
  deleteAgentRuntimeUntilGone,
} from './agent-runtime-status.ts';
import { type AwsEnvironment, executionRoleName } from './aws-environment.ts';

/**
 * Walks EVERY permission the AgentCore tests need, to the end of the path, and
 * throws naming exactly which are missing — before anything is provisioned.
 * Creates nothing durable.
 *
 * This exists because on 2026-09-22 the first probe checked `iam:CreateRole`,
 * found it denied, and asked the operator for a role — but the permission that
 * actually blocks `CreateAgentRuntime` is `iam:PassRole`, which was never
 * probed. Half a fix cost the whole AgentCore half of a night. So the decisive
 * probe is the last one: a real `CreateAgentRuntime` with an image URI that
 * does not exist. If IAM is correct it fails validation on the image; if IAM
 * is not, it fails on authorization. Either way nothing is created — and if
 * something is, its deletion is deferred onto `resources`, whose release waits
 * until it is gone.
 */
export async function verifyAgentCoreAccess(
  resources: AsyncDisposableStack,
  environment: AwsEnvironment,
): Promise<void> {
  const { region } = environment;
  const control = new BedrockAgentCoreControlClient({ region });
  const ecr = new ECRClient({ region });
  const failures: string[] = [];
  const probe = async (
    permission: string,
    call: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await call();
    } catch (error) {
      failures.push(describeProbeFailure(permission, error));
    }
  };

  await probe('bedrock-agentcore:ListAgentRuntimes', () =>
    control.send(new ListAgentRuntimesCommand({ maxResults: 1 })),
  );
  await probe('ecr:DescribeRepositories', () =>
    ecr.send(new DescribeRepositoriesCommand({ maxResults: 1 })),
  );
  await probe('ecr:GetAuthorizationToken', () =>
    ecr.send(new GetAuthorizationTokenCommand({})),
  );
  await probe('dynamodb:ListTables', () =>
    new DynamoDBClient({ region }).send(new ListTablesCommand({ Limit: 1 })),
  );
  await probe('logs:DescribeLogGroups', () =>
    new CloudWatchLogsClient({ region }).send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: '/aws/bedrock-agentcore',
        limit: 1,
      }),
    ),
  );

  // The role's existence. `iam:GetRole` being denied is harmless — PassRole is
  // what matters, and the decisive probe below checks it.
  try {
    await new IAMClient({ region }).send(
      new GetRoleCommand({ RoleName: executionRoleName }),
    );
  } catch (error) {
    if (errorName(error) === 'NoSuchEntityException') {
      failures.push(
        `the execution role ${environment.executionRoleArn} does not exist — an admin must create it once (integ/aws/agentcore/README.md)`,
      );
    } else if (!isAccessDenied(error)) {
      failures.push(describeProbeFailure('iam:GetRole', error));
    }
  }

  const decisive = await probeCreateAgentRuntime(
    resources,
    control,
    environment,
  );
  if (decisive !== undefined) failures.push(decisive);

  if (failures.length > 0) {
    throw new Error(
      `AgentCore access check failed for ${environment.callerArn} in ${region}; nothing was provisioned:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`,
    );
  }
}

/** Returns what is missing, or `undefined` when the IAM path is clear. */
async function probeCreateAgentRuntime(
  resources: AsyncDisposableStack,
  control: BedrockAgentCoreControlClient,
  environment: AwsEnvironment,
): Promise<string | undefined> {
  // Unique per call: the AgentCore files run their checks in parallel.
  const probeName = `agentforge_integ_access_probe_${randomUUIDv7().replaceAll('-', '').slice(-10)}`;
  try {
    const created = await control.send(
      new CreateAgentRuntimeCommand({
        agentRuntimeName: probeName,
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: `${environment.registry}/agentforge/does-not-exist:none`,
          },
        },
        roleArn: environment.executionRoleArn,
        // No `platformVersion`: the probe asks IAM a question, and the default
        // platform version is where a missing image was refused at once. A V2
        // create is prepared for minutes, and whether it checks the image
        // before accepting is not documented.
        networkConfiguration: { networkMode: 'PUBLIC' },
        tags: { [integTag.Key]: integTag.Value },
      }),
    );
    // It should not have succeeded against a nonexistent image, so the probe's
    // premise — that it creates nothing — no longer holds. Fail, and leave its
    // deletion to the file's teardown, which waits out CREATING and then
    // DELETING, and fails naming it if it cannot.
    const runtime = agentRuntimeReferenceFrom(created, probeName);
    resources.defer(() => deleteAgentRuntimeUntilGone(control, runtime));
    return `CreateAgentRuntime SUCCEEDED against a nonexistent image, so the access probe is no longer side-effect free; ${runtime.agentRuntimeArn} is deleted in teardown`;
  } catch (error) {
    if (isAccessDenied(error) && errorMessage(error).includes('iam:PassRole')) {
      return `iam:PassRole on ${environment.executionRoleArn} is denied — ${environment.callerArn} must carry integ/aws/test-role-permissions-policy.json (integ/aws/agentcore/README.md)`;
    }
    // Refused on the image, which means authorization passed. Anything else —
    // throttling, a network failure, a service error — proves nothing about
    // authorization.
    if (errorName(error) === 'ValidationException') return undefined;
    return describeProbeFailure('bedrock-agentcore:CreateAgentRuntime', error);
  }
}

function describeProbeFailure(permission: string, error: unknown): string {
  if (isCredentialFailure(error)) {
    return `${permission}: the credentials are not usable (${errorName(error)}: ${errorMessage(error)}) — re-authenticate (aws sso login --profile "$AWS_PROFILE") and re-run`;
  }
  if (isAccessDenied(error)) {
    const denied = /not authorized to perform: ([\w:*-]+)/.exec(
      errorMessage(error),
    )?.[1];
    return `${denied ?? permission} is DENIED (${errorMessage(error)})`;
  }
  return `${permission}: unexpected ${errorName(error)}: ${errorMessage(error)}`;
}

function isAccessDenied(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === 'AccessDeniedException' ||
    name === 'AccessDenied' ||
    name === 'UnauthorizedOperation' ||
    /not authorized to perform/i.test(errorMessage(error))
  );
}

function isCredentialFailure(error: unknown): boolean {
  return [
    'ExpiredTokenException',
    'ExpiredToken',
    'InvalidClientTokenId',
    'UnrecognizedClientException',
    'CredentialsProviderError',
    'TokenProviderError',
  ].includes(errorName(error));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
