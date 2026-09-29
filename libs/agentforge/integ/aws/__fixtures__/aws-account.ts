import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * Everything the AWS integration tests create carries this tag, and is deleted
 * by the test file that created it, so nothing outlives a run — and whatever a
 * killed run leaves behind is found by it (integ/aws/agentcore/README.md).
 * Shaped as ECR, DynamoDB and S3 take a tag; AgentCore takes a map.
 */
export const INTEG_TAG = { Key: 'agentforge:integ', Value: 'true' } as const;

export interface CallerIdentity {
  readonly accountId: string;
  /** The identity the tests run as — never an admin. */
  readonly callerArn: string;
}

/** The account comes from STS, never from the source. */
export async function resolveCallerIdentity(
  region: string,
): Promise<CallerIdentity> {
  const identity = await new STSClient({ region }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account === undefined || identity.Arn === undefined) {
    throw new Error(
      `STS GetCallerIdentity returned no Account or Arn: ${JSON.stringify(identity)}`,
    );
  }
  return { accountId: identity.Account, callerArn: identity.Arn };
}
