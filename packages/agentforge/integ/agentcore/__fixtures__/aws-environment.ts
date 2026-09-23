import { randomUUIDv7 } from 'node:crypto';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * Everything these tests create in AWS carries this tag, and is deleted by the
 * test file that created it, so nothing outlives a run.
 */
export const integTag = { key: 'agentforge:integ', value: 'true' } as const;

/**
 * The execution role AgentCore assumes. It needs an ADMIN identity to create,
 * which the tests do not have — see integ/agentcore/README.md.
 */
export const executionRoleName = 'agentforge-integ-agentcore-execution';

/** The execution role may touch only DynamoDB tables named with this prefix. */
export const leaseTableNamePrefix = 'agentforge-integ-';

export interface AwsEnvironment {
  readonly accountId: string;
  readonly region: string;
  /** The identity the tests run as — never an admin. */
  readonly callerArn: string;
  readonly executionRoleArn: string;
  /** `<account>.dkr.ecr.<region>.amazonaws.com` */
  readonly registry: string;
}

/**
 * The account is derived from STS, never hard-coded. The region is required
 * explicitly: Nx loads `.env`, which sets `AWS_PROFILE` and `AWS_REGION`, into
 * every task, and a test run outside Nx must set them itself.
 */
export async function resolveAwsEnvironment(): Promise<AwsEnvironment> {
  const region = process.env.AWS_REGION;
  if (region === undefined || region === '') {
    throw new Error(
      'AWS_REGION is not set; run through `nx run @beruangai/agentforge:integ`, which loads it from .env',
    );
  }
  const identity = await new STSClient({ region }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account === undefined || identity.Arn === undefined) {
    throw new Error(
      `STS GetCallerIdentity returned no Account or Arn: ${JSON.stringify(identity)}`,
    );
  }
  return {
    accountId: identity.Account,
    region,
    callerArn: identity.Arn,
    executionRoleArn: `arn:aws:iam::${identity.Account}:role/${executionRoleName}`,
    registry: `${identity.Account}.dkr.ecr.${region}.amazonaws.com`,
  };
}

/**
 * Names for one test file's resources. A suffix from the random tail of a
 * uuid7 keeps two runs — or a run and a leftover — from colliding, and the
 * purpose says which test file a leftover came from.
 *
 * `agentRuntimeName` is `[a-zA-Z][a-zA-Z0-9_]{0,47}` and an ECR repository is
 * lower-case with hyphens, so one string cannot name both
 * (docs/research/agentcore-runtime.md).
 */
export interface ResourceNames {
  readonly agentRuntimeName: string;
  readonly repositoryName: string;
  readonly leaseTableName: string;
}

export function resourceNamesFor(purpose: string): ResourceNames {
  if (!/^[a-z][a-z0-9_]*$/.test(purpose)) {
    throw new Error(
      `purpose "${purpose}" must be lower-case letters, digits and underscores, starting with a letter`,
    );
  }
  const suffix = randomUUIDv7().replaceAll('-', '').slice(-10);
  const agentRuntimeName = `agentforge_integ_${purpose}_${suffix}`;
  if (agentRuntimeName.length > 48) {
    throw new Error(
      `runtime name ${agentRuntimeName} is ${agentRuntimeName.length} characters; AgentCore allows 48 — shorten the purpose "${purpose}"`,
    );
  }
  const hyphenated = purpose.replaceAll('_', '-');
  return {
    agentRuntimeName,
    repositoryName: `agentforge/integ-${hyphenated}-${suffix}`,
    leaseTableName: `${leaseTableNamePrefix}lease-${hyphenated}-${suffix}`,
  };
}

/** AgentCore requires a `runtimeSessionId` of at least 33 characters. */
export function newRuntimeSessionId(label: string): string {
  return `${label}-${randomUUIDv7()}`;
}
