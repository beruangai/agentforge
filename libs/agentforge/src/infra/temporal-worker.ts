import { existsSync } from 'node:fs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  type ISecurityGroup,
  SecurityGroup,
  type SubnetSelection,
} from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  type ICluster,
  LogDrivers,
  OperatingSystemFamily,
  Secret,
} from 'aws-cdk-lib/aws-ecs';
import type { IGrantable, IPrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/** The Temporal Cloud API key's variable, as `@temporalio/envconfig` reads it. */
const TEMPORAL_API_KEY = 'TEMPORAL_API_KEY';
/** The variables the construct sets itself, besides the API key. */
const OWNED_VARIABLES = [
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
  'AGENTFORGE_AGENTS',
] as const;
/** Every `TEMPORAL_*` variable configures the connection, which the construct owns. */
const TEMPORAL_VARIABLE_PREFIX = 'TEMPORAL_';
/**
 * Fargate's ceiling before `SIGKILL`, above the worker's default 110 s
 * shutdown grace (docs/research/temporal.md).
 */
const STOP_TIMEOUT = Duration.seconds(120);

/**
 * A worker's secrets, by the environment variable each becomes: the Temporal
 * Cloud API key, and each of `Declared`. A workflow project's generated
 * construct declares its project's.
 */
export type WorkerSecrets<Declared extends string> = {
  readonly [TEMPORAL_API_KEY]: ISecret;
} & { readonly [Name in Declared]: ISecret };

export interface TemporalWorkerProps {
  readonly cluster: ICluster;
  /** The worker's image build context: the project's `bundle` output. */
  readonly directory: string;
  /** The Temporal Cloud namespace the worker polls, and its endpoint. */
  readonly temporal: { readonly address: string; readonly namespace: string };
  /**
   * Secrets the worker reads, by the environment variable each becomes. ECS
   * injects them at start, reading with the execution role; the worker's own
   * role is granted none.
   */
  readonly secrets: WorkerSecrets<string>;
  /** How the worker reaches agents: `runtime-config:<applicationId>`, set by the generated construct. */
  readonly agents: string;
  /** The consumer's own variables; never a `TEMPORAL_*` variable, `AGENTFORGE_AGENTS` or a secret's name. */
  readonly environment?: Readonly<Record<string, string>>;
  /** @default 256 */
  readonly cpu?: number;
  /** @default 512 */
  readonly memoryLimitMiB?: number;
  /** @default 1 */
  readonly desiredCount?: number;
  readonly vpcSubnets?: SubnetSelection;
  /** @default a security group of its own, with no ingress and all egress */
  readonly securityGroups?: readonly ISecurityGroup[];
  readonly assignPublicIp?: boolean;
  /** @default RetentionDays.THREE_MONTHS */
  readonly logRetention?: RetentionDays;
  /**
   * What happens to the log group when the stack deletes it.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * A workflow project's worker as an ECS Fargate service polling Temporal
 * Cloud: one ARM64 container from the worker's build context, given 120 s to
 * drain before it is killed, its secrets injected by ECS, its logs in a group
 * of its own. A deploy completes only once the new task runs, and rolls back
 * when it cannot start; the old task stops only once the new one runs. Nothing
 * may connect to it. Its role is granted nothing here: what it calls is
 * granted to it as an `IGrantable`.
 */
export class TemporalWorker extends Construct implements IGrantable {
  readonly service: FargateService;
  /** The task role: what the worker's code runs as. */
  readonly grantPrincipal: IPrincipal;

  constructor(scope: Construct, id: string, props: TemporalWorkerProps) {
    super(scope, id);
    const {
      cluster,
      directory,
      temporal,
      secrets,
      agents,
      environment = {},
      cpu = 256,
      memoryLimitMiB = 512,
      desiredCount = 1,
      securityGroups,
      logRetention = RetentionDays.THREE_MONTHS,
      removalPolicy = RemovalPolicy.RETAIN,
      // vpcSubnets and assignPublicIp, passed through as given.
      ...network
    } = props;
    for (const name of Object.keys(environment)) {
      if (
        name.startsWith(TEMPORAL_VARIABLE_PREFIX) ||
        (OWNED_VARIABLES as readonly string[]).includes(name)
      ) {
        throw new Error(
          `${name} is set by TemporalWorker; remove it from environment`,
        );
      }
    }
    if (secrets[TEMPORAL_API_KEY] === undefined) {
      throw new Error(`${TEMPORAL_API_KEY} is required: declare it in secrets`);
    }
    for (const name of Object.keys(secrets)) {
      if ((OWNED_VARIABLES as readonly string[]).includes(name)) {
        throw new Error(
          `${name} is set by TemporalWorker; remove it from secrets`,
        );
      }
      if (name in environment) {
        throw new Error(
          `${name} is declared both as a secret and in environment`,
        );
      }
    }
    if (!existsSync(directory)) {
      throw new Error(`the worker's build context ${directory} does not exist`);
    }

    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      cpu,
      memoryLimitMiB,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.ARM64,
      },
    });
    const logGroup = new LogGroup(this, 'Logs', {
      retention: logRetention,
      removalPolicy,
    });
    taskDefinition.addContainer('Worker', {
      image: ContainerImage.fromAsset(directory, {
        platform: Platform.LINUX_ARM64,
      }),
      stopTimeout: STOP_TIMEOUT,
      environment: {
        ...environment,
        TEMPORAL_ADDRESS: temporal.address,
        TEMPORAL_NAMESPACE: temporal.namespace,
        AGENTFORGE_AGENTS: agents,
      },
      secrets: Object.fromEntries(
        Object.entries(secrets).map(([name, secret]) => [
          name,
          Secret.fromSecretsManager(secret),
        ]),
      ),
      logging: LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup }),
    });

    this.service = new FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      ...network,
      securityGroups: securityGroups
        ? [...securityGroups]
        : [
            new SecurityGroup(this, 'SecurityGroup', {
              vpc: cluster.vpc,
              description: 'A Temporal worker: no ingress, all egress',
              allowAllOutbound: true,
            }),
          ],
    });
    this.grantPrincipal = taskDefinition.taskRole;
  }
}
