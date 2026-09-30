import { GoldenKata, GoldenKataWorkflows } from '@beruangai/common-constructs';
import {
  Aspects,
  CfnOutput,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import {
  CfnConfigurationProfile,
  CfnEnvironment,
} from 'aws-cdk-lib/aws-appconfig';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct, IConstruct } from 'constructs';

/** The operator's Temporal Cloud namespace, and its endpoint. */
const TEMPORAL = {
  address: 'beruangai-agentforge.vwhld.tmprl.cloud:7233',
  namespace: 'beruangai-agentforge.vwhld',
} as const;

export class ApplicationStack extends Stack {
  readonly goldenKata: GoldenKata;
  /** golden-kata-workflows' worker: golden-kata's caller. */
  readonly workflows: GoldenKataWorkflows;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // A test deployment: `destroy` removes everything, its buckets emptied
    // first (scripts/empty-buckets.ts). A consumer's keeps the default, RETAIN.
    const removalPolicy = RemovalPolicy.DESTROY;
    // And `destroy` runs right after an e2e has read the runtime
    // configuration, which AppConfig's deletion protection would refuse for
    // an hour. The runtime configuration's resources are created by an aspect
    // at synthesis, so another aspect reaches them. A consumer's keeps the
    // account's protection.
    Aspects.of(this).add({
      visit(node: IConstruct) {
        if (
          node instanceof CfnEnvironment ||
          node instanceof CfnConfigurationProfile
        ) {
          node.deletionProtectionCheck = 'BYPASS';
        }
      },
    });
    // The operator creates these secrets and sets their values.
    const subscriptionToken = Secret.fromSecretNameV2(
      this,
      'SubscriptionToken',
      'agentforge/claude-code-oauth-token',
    );
    const temporalApiKey = Secret.fromSecretNameV2(
      this,
      'TemporalApiKey',
      'agentforge/temporal-api-key',
    );
    const agent = {
      removalPolicy,
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken },
    };
    this.goldenKata = new GoldenKata(this, 'GoldenKata', {
      agents: { writer: agent, grader: agent },
    });

    // The worker only calls out — Temporal Cloud, AgentCore, AppConfig — so
    // public subnets and a public address, without a NAT gateway's cost.
    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }],
    });
    const cluster = new Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
    });
    this.workflows = new GoldenKataWorkflows(this, 'GoldenKataWorkflows', {
      cluster,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      assignPublicIp: true,
      temporal: TEMPORAL,
      secrets: { TEMPORAL_API_KEY: temporalApiKey },
      agenticProjects: { goldenKata: this.goldenKata },
      removalPolicy,
    });

    new CfnOutput(this, 'WriterSessionBucketName', {
      value: this.goldenKata.agents.writer.sessionBucket.bucketName,
    });
    new CfnOutput(this, 'GraderSessionBucketName', {
      value: this.goldenKata.agents.grader.sessionBucket.bucketName,
    });
  }
}
