import { randomUUIDv7 } from 'node:crypto';
import { resolveCallerIdentity } from '../../__fixtures__/aws-account.ts';

/**
 * The execution role AgentCore assumes. It needs an ADMIN identity to create,
 * which the tests do not have — see integ/aws/agentcore/README.md.
 */
export const EXECUTION_ROLE_NAME = 'agentforge-integ-agentcore-execution';

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
 * explicitly: Nx loads `.env.integ`, which sets `AWS_PROFILE` and `AWS_REGION`,
 * into the `integ` task alone, and a test run outside Nx must set them itself.
 */
export async function resolveAwsEnvironment(): Promise<AwsEnvironment> {
  const region = process.env.AWS_REGION;
  if (region === undefined || region === '') {
    throw new Error(
      'AWS_REGION is not set; run through `nx run @beruangai/agentforge:integ`, which loads it from .env.integ',
    );
  }
  const { accountId, callerArn } = await resolveCallerIdentity(region);
  return {
    accountId,
    region,
    callerArn,
    executionRoleArn: `arn:aws:iam::${accountId}:role/${EXECUTION_ROLE_NAME}`,
    registry: `${accountId}.dkr.ecr.${region}.amazonaws.com`,
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
  /** `agentforge-integ-*`, the only DynamoDB tables the execution role may touch. */
  readonly outcomeTableName: string;
  /** A CloudFormation stack, for a runtime deployed through the construct. */
  readonly stackName: string;
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
    outcomeTableName: `agentforge-integ-outcome-${hyphenated}-${suffix}`,
    stackName: `agentforge-integ-${hyphenated}-${suffix}`,
  };
}

/** AgentCore requires a `runtimeSessionId` of at least 33 characters. */
export function newRuntimeSessionId(label: string): string {
  return `${label}-${randomUUIDv7()}`;
}
