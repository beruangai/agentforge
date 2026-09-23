import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
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
import {
  type AwsEnvironment,
  executionRoleName,
  integTag,
} from './aws-environment.ts';

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
 * does not exist. If IAM is correct it fails on the image or on validation; if
 * IAM is not, it fails on authorization. Either way nothing is created.
 */
export async function verifyAgentCoreAccess(
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
        `the execution role ${environment.executionRoleArn} does not exist — an admin must create it once (integ/agentcore/README.md)`,
      );
    } else if (!isAccessDenied(error)) {
      failures.push(describeProbeFailure('iam:GetRole', error));
    }
  }

  const decisive = await probeCreateAgentRuntime(control, environment);
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
  control: BedrockAgentCoreControlClient,
  environment: AwsEnvironment,
): Promise<string | undefined> {
  const probeName = 'agentforge_integ_access_probe';
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
        networkConfiguration: { networkMode: 'PUBLIC' },
        tags: { [integTag.key]: integTag.value },
      }),
    );
    // It should not have succeeded against a nonexistent image. Delete it, and
    // fail: the probe's premise — that it creates nothing — no longer holds.
    if (created.agentRuntimeId !== undefined) {
      await control.send(
        new DeleteAgentRuntimeCommand({
          agentRuntimeId: created.agentRuntimeId,
        }),
      );
    }
    return `CreateAgentRuntime SUCCEEDED against a nonexistent image, so the access probe is no longer side-effect free; deletion of ${created.agentRuntimeArn ?? probeName} was requested — confirm it is gone`;
  } catch (error) {
    if (isAccessDenied(error)) {
      const message = errorMessage(error);
      if (message.includes('iam:PassRole')) {
        return `iam:PassRole on ${environment.executionRoleArn} is denied — an admin must attach integ/agentcore/__fixtures__/agentcore-passrole-policy.json to ${environment.callerArn}`;
      }
      return describeProbeFailure(
        'bedrock-agentcore:CreateAgentRuntime',
        error,
      );
    }
    if (isCredentialFailure(error)) {
      return describeProbeFailure(
        'bedrock-agentcore:CreateAgentRuntime',
        error,
      );
    }
    if (errorName(error) === 'ConflictException') {
      return `a runtime named ${probeName} already exists — an earlier probe left it behind; delete it`;
    }
    // Failed on the image or on validation, which means authorization passed.
    return undefined;
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
