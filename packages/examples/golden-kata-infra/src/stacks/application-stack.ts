import { GoldenKata } from '@beruangai/common-constructs';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AccountRootPrincipal, Role } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export class ApplicationStack extends Stack {
  readonly goldenKata: GoldenKata;
  /** Whatever calls golden-kata's agents: the stand-in for a consumer's Temporal worker. */
  readonly caller: Role;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // A test deployment: `destroy` removes everything, its buckets emptied
    // first (scripts/empty-buckets.ts). A consumer's keeps the default, RETAIN.
    const removalPolicy = RemovalPolicy.DESTROY;
    // The operator creates this secret and sets its value.
    const subscriptionToken = Secret.fromSecretNameV2(
      this,
      'SubscriptionToken',
      'agentforge/claude-code-oauth-token',
    );
    const agent = {
      removalPolicy,
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken },
    };
    this.goldenKata = new GoldenKata(this, 'GoldenKata', {
      agents: { writer: agent, grader: agent },
    });
    this.caller = new Role(this, 'Caller', {
      assumedBy: new AccountRootPrincipal(),
    });
    this.goldenKata.grantInvoke(this.caller);

    new CfnOutput(this, 'CallerRoleArn', { value: this.caller.roleArn });
    new CfnOutput(this, 'WriterSessionBucketName', {
      value: this.goldenKata.agents.writer.sessionBucket.bucketName,
    });
    new CfnOutput(this, 'GraderSessionBucketName', {
      value: this.goldenKata.agents.grader.sessionBucket.bucketName,
    });
  }
}
