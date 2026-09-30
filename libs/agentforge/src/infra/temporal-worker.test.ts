import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { TemporalWorker, type TemporalWorkerProps } from './temporal-worker.ts';

const DIRECTORY = fileURLToPath(
  new URL('./__fixtures__/temporal-worker/', import.meta.url),
);

function synthesize(
  props: (stack: Stack) => Partial<TemporalWorkerProps> = () => ({}),
  after: (stack: Stack, worker: TemporalWorker) => void = () => {},
): Template {
  const stack = new Stack(new App(), 'Worker', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  // Imported: the concrete L2s' optional members defeat this package's
  // exactOptionalPropertyTypes, which a consumer's infrastructure does not set.
  const cluster = Cluster.fromClusterAttributes(stack, 'Cluster', {
    clusterName: 'cluster',
    vpc: Vpc.fromVpcAttributes(stack, 'Vpc', {
      vpcId: 'vpc-12345678',
      availabilityZones: ['us-east-2a', 'us-east-2b'],
      publicSubnetIds: ['subnet-0a000000000000001', 'subnet-0a000000000000002'],
      privateSubnetIds: [
        'subnet-0b000000000000001',
        'subnet-0b000000000000002',
      ],
    }),
  });
  const worker = new TemporalWorker(stack, 'Worker', {
    cluster,
    directory: DIRECTORY,
    temporal: {
      address: 'namespace.account.tmprl.cloud:7233',
      namespace: 'namespace.account',
    },
    secrets: {
      TEMPORAL_API_KEY: Secret.fromSecretNameV2(
        stack,
        'ApiKey',
        'agentforge/temporal-api-key',
      ),
    },
    agents: 'runtime-config:application',
    ...props(stack),
  });
  after(stack, worker);
  return Template.fromStack(stack);
}

describe('TemporalWorker', () => {
  it('runs one ARM64 Fargate container, given 120 s to drain, connected by the environment beside what the consumer declares', () => {
    synthesize(() => ({
      environment: { LOG_LEVEL: 'debug' },
    })).hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
      Cpu: '256',
      Memory: '512',
      ContainerDefinitions: [
        Match.objectLike({
          StopTimeout: 120,
          Environment: Match.arrayWith([
            { Name: 'LOG_LEVEL', Value: 'debug' },
            {
              Name: 'TEMPORAL_ADDRESS',
              Value: 'namespace.account.tmprl.cloud:7233',
            },
            { Name: 'TEMPORAL_NAMESPACE', Value: 'namespace.account' },
            { Name: 'AGENTFORGE_AGENTS', Value: 'runtime-config:application' },
          ]),
        }),
      ],
    });
  });

  it('sizes the task as the consumer chooses', () => {
    synthesize(() => ({
      cpu: 1024,
      memoryLimitMiB: 2048,
    })).hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '1024',
      Memory: '2048',
    });
  });

  it('injects each secret through ECS, readable by the execution role and not the task role', () => {
    const template = synthesize((stack) => ({
      secrets: {
        TEMPORAL_API_KEY: Secret.fromSecretNameV2(
          stack,
          'DeclaredApiKey',
          'agentforge/temporal-api-key',
        ),
        OPENAI_API_KEY: Secret.fromSecretNameV2(stack, 'Other', 'other'),
      },
    }));
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Secrets: [
            Match.objectLike({ Name: 'TEMPORAL_API_KEY' }),
            Match.objectLike({ Name: 'OPENAI_API_KEY' }),
          ],
        }),
      ],
    });
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).map((policy) => JSON.stringify(policy.Properties));
    const readers = policies.filter((policy) =>
      policy.includes('secretsmanager:GetSecretValue'),
    );
    expect(readers).toHaveLength(1);
    expect(readers[0]).toMatch(/ExecutionRole/);
    expect(readers[0]).not.toMatch(/TaskRole/);
  });

  it('logs to a log group of its own, kept three months and retained', () => {
    const template = synthesize();
    template.hasResource('AWS::Logs::LogGroup', {
      Properties: { RetentionInDays: 90 },
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          LogConfiguration: {
            LogDriver: 'awslogs',
            Options: Match.objectLike({
              'awslogs-group': { Ref: Match.stringLikeRegexp('WorkerLogs') },
            }),
          },
        }),
      ],
    });
  });

  it('deploys as a service that rolls back when the worker cannot start, and stops the old worker only once the new one runs', () => {
    synthesize(() => ({ desiredCount: 2 })).hasResourceProperties(
      'AWS::ECS::Service',
      {
        LaunchType: 'FARGATE',
        DesiredCount: 2,
        DeploymentConfiguration: Match.objectLike({
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          MinimumHealthyPercent: 100,
        }),
        LoadBalancers: Match.absent(),
      },
    );
  });

  it('runs one worker by default, in a security group nothing may connect to', () => {
    const template = synthesize();
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'DISABLED',
          SecurityGroups: [
            {
              'Fn::GetAtt': [
                Match.stringLikeRegexp('WorkerSecurityGroup'),
                'GroupId',
              ],
            },
          ],
        }),
      },
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.absent(),
      SecurityGroupEgress: [
        Match.objectLike({ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }),
      ],
    });
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  it("passes the consumer's network through", () => {
    const template = synthesize((stack) => ({
      assignPublicIp: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [
        SecurityGroup.fromSecurityGroupId(stack, 'Given', 'sg-12345678'),
      ],
    }));
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'ENABLED',
          SecurityGroups: ['sg-12345678'],
          Subnets: ['subnet-0a000000000000001', 'subnet-0a000000000000002'],
        },
      },
    });
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  });

  it('is granted as its task role', () => {
    const template = synthesize(
      () => ({}),
      (stack, worker) => new Bucket(stack, 'Bucket').grantRead(worker),
    );
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['s3:GetObject*']) }),
        ]),
      },
      Roles: [{ Ref: Match.stringLikeRegexp('WorkerTaskDefinitionTaskRole') }],
    });
  });

  describe('refuses at synth', () => {
    it.each([
      'TEMPORAL_ADDRESS',
      'TEMPORAL_NAMESPACE',
      'TEMPORAL_API_KEY',
      'TEMPORAL_TLS',
      'AGENTFORGE_AGENTS',
    ])('%s in environment', (name) => {
      expect(() =>
        synthesize(() => ({ environment: { [name]: 'x' } })),
      ).toThrow(`${name} is set by TemporalWorker; remove it from environment`);
    });

    it('a secret also in environment', () => {
      expect(() =>
        synthesize((stack) => ({
          secrets: {
            TEMPORAL_API_KEY: Secret.fromSecretNameV2(
              stack,
              'DeclaredApiKey',
              'key',
            ),
            OPENAI_API_KEY: Secret.fromSecretNameV2(stack, 'Other', 'other'),
          },
          environment: { OPENAI_API_KEY: 'plain' },
        })),
      ).toThrow(
        'OPENAI_API_KEY is declared both as a secret and in environment',
      );
    });

    it('a secret named for a variable it sets', () => {
      expect(() =>
        synthesize((stack) => ({
          secrets: {
            TEMPORAL_API_KEY: Secret.fromSecretNameV2(
              stack,
              'DeclaredApiKey',
              'key',
            ),
            AGENTFORGE_AGENTS: Secret.fromSecretNameV2(stack, 'Other', 'other'),
          },
        })),
      ).toThrow(
        'AGENTFORGE_AGENTS is set by TemporalWorker; remove it from secrets',
      );
    });

    it('secrets without the API key', () => {
      expect(() =>
        synthesize(() => ({
          secrets: {} as TemporalWorkerProps['secrets'],
        })),
      ).toThrow('TEMPORAL_API_KEY is required: declare it in secrets');
    });

    it('a build context that does not exist', () => {
      expect(() =>
        synthesize(() => ({ directory: '/nonexistent/worker/bundle' })),
      ).toThrow(
        "the worker's build context /nonexistent/worker/bundle does not exist",
      );
    });
  });
});
