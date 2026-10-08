import { ArnFormat, Lazy, Stack, Validations } from 'aws-cdk-lib';
import {
  type CfnRuntime,
  ProtocolType,
  Runtime,
  type RuntimeProps,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import {
  type Grant,
  type IGrantable,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { A2A_VERSION_HEADER } from '#core/a2a-version.ts';
import { AGENT_IMAGE_VARIABLE } from '#core/agent-image.ts';
import { AGENT_NAME_PATTERN, AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import {
  FILESYSTEM_BUCKETS_VARIABLE,
  FILESYSTEM_NAME_PATTERN,
} from '#core/filesystem.ts';
import { METRICS_NAMESPACE, METRICS_VARIABLE } from '#core/metrics.ts';
import {
  REQUIRED_SECRETS,
  type RequiredSecret,
  SECRETS_VARIABLE,
} from '#core/secrets.ts';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';
import { TASK_TABLE_NAME_VARIABLE } from '#core/task-table.ts';
import { TELEMETRY_VARIABLE, type TelemetryLevel } from '#core/telemetry.ts';
import type { AgenticProjectResources } from './agentic-project-resources.ts';
import type { S3FilesystemBucket } from './s3-filesystem-bucket.ts';

/** A secret as `AgentRuntime` reads it: its ARN, and read granted to the runtime's role. */
export type AgentSecret = Pick<ISecret, 'secretArn' | 'grantRead'>;

/**
 * An agent's secrets, by the environment variable each becomes: AgentForge's
 * own, the subscription token, and each of `Declared`. An agent's generated
 * construct declares its project's and its own.
 */
export type AgentSecrets<Declared extends string = never> = Readonly<
  Record<RequiredSecret | Declared, AgentSecret>
>;

/**
 * The L2 `Runtime`'s props, less the protocol, which is A2A, and the
 * authorizer: the readiness probe, `grantInvoke` and `agentCoreTransport` all
 * sign with IAM SigV4, so a JWT authorizer could only fail the deploy.
 */
export interface AgentRuntimeProps
  extends Omit<
    RuntimeProps,
    'protocolConfiguration' | 'authorizerConfiguration'
  > {
  /** The project's shared resources, which this agent's tasks and transcripts live in. */
  readonly project: AgenticProjectResources;
  /**
   * The agent's name within its project, as its image names it; matches
   * `AGENT_NAME_PATTERN`. Its tasks and transcripts are scoped by it.
   */
  readonly agentName: string;
  /**
   * Whether the runtime delivers its service spans to AgentCore Observability.
   * @default true
   */
  readonly tracingEnabled?: boolean;
  /**
   * Secrets the agent reads, by the environment variable each becomes: the
   * subscription token as `CLAUDE_CODE_OAUTH_TOKEN`, and any the agent's
   * layers require. The runtime may read these and no others (§REQ705); the
   * server reads them on its first request.
   */
  readonly secrets: AgentSecrets & Readonly<Record<string, AgentSecret>>;
  /**
   * How much of the Claude CLI's telemetry the agent exports to CloudWatch,
   * as a log level: `WARN`, metrics and error events; `INFO`, every event
   * and trace, no content; `DEBUG`, prompts and tool content too; `ALL`, the
   * raw API bodies too.
   * @default 'INFO'
   */
  readonly telemetry?: TelemetryLevel;
  /**
   * The buckets the agent's `S3Filesystem`s may mount, by the name each
   * declares as its `bucket`. A bucket may be given to several agents.
   */
  readonly filesystems?: Readonly<Record<string, S3FilesystemBucket>>;
}

/**
 * One deployed agent of a project: an AgentCore runtime on platform version
 * V2 serving the agent's image over A2A, pointed at the project's task table
 * and session bucket — granted the table, and the bucket under its own name
 * only — with its section on the project's dashboard. A deploy completes
 * only once the runtime serves: the project's readiness probe runs after
 * every change to the runtime, asking it for an unknown task until
 * AgentForge's server answers. Everything else a runtime takes — its image,
 * role, network, lifecycle, environment — is the consumer's, as the L2
 * `Runtime` takes it; the A2A-Version header, the table's name and the
 * agent's name are added to what it declares.
 * AgentCore Observability is on unless the consumer turns it off: the runtime
 * delivers its service spans, which needs CloudWatch Transaction Search in the
 * account (a one-time setup).
 */
export class AgentRuntime extends Construct {
  readonly runtime: Runtime;
  /**
   * The container URI the runtime runs, which every task it admits records
   * (§REQ601): an asset's is tagged by its content hash.
   */
  readonly image: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
    super(scope, id);
    const {
      project,
      agentName,
      tracingEnabled = true,
      secrets,
      telemetry = 'INFO',
      filesystems = {},
      environmentVariables = {},
      requestHeaderConfiguration,
      ...runtimeProps
    } = props;
    if (!AGENT_NAME_PATTERN.test(agentName)) {
      throw new Error(
        `agent name "${agentName}" must match ${AGENT_NAME_PATTERN}`,
      );
    }
    for (const owned of [
      AGENT_NAME_VARIABLE,
      AGENT_IMAGE_VARIABLE,
      TASK_TABLE_NAME_VARIABLE,
      SESSION_BUCKET_VARIABLE,
      METRICS_VARIABLE,
      SECRETS_VARIABLE,
      TELEMETRY_VARIABLE,
      FILESYSTEM_BUCKETS_VARIABLE,
    ]) {
      if (owned in environmentVariables) {
        throw new Error(
          `${owned} is set by AgentRuntime; remove it from environmentVariables`,
        );
      }
    }
    for (const name of Object.keys(filesystems)) {
      if (!FILESYSTEM_NAME_PATTERN.test(name)) {
        throw new Error(
          `filesystem bucket name "${name}" must match ${FILESYSTEM_NAME_PATTERN}`,
        );
      }
    }
    for (const name of REQUIRED_SECRETS) {
      if (secrets[name] === undefined) {
        throw new Error(`${name} is required: declare it in secrets`);
      }
    }
    for (const name of Object.keys(secrets)) {
      if (name in environmentVariables) {
        throw new Error(
          `${name} is declared both as a secret and in environmentVariables`,
        );
      }
    }

    const allowlistedHeaders =
      requestHeaderConfiguration?.allowlistedHeaders ?? [];
    this.runtime = new Runtime(this, 'Runtime', {
      ...runtimeProps,
      tracingEnabled,
      protocolConfiguration: ProtocolType.A2A,
      requestHeaderConfiguration: {
        ...requestHeaderConfiguration,
        allowlistedHeaders: allowlistedHeaders.includes(A2A_VERSION_HEADER)
          ? allowlistedHeaders
          : [...allowlistedHeaders, A2A_VERSION_HEADER],
      },
      environmentVariables: {
        ...environmentVariables,
        [AGENT_NAME_VARIABLE]: agentName,
        [TASK_TABLE_NAME_VARIABLE]: project.taskTable.tableName,
        [SESSION_BUCKET_VARIABLE]: project.sessionBucket.bucketName,
        [TELEMETRY_VARIABLE]: telemetry,
        [SECRETS_VARIABLE]: Stack.of(this).toJsonString(
          Object.fromEntries(
            Object.entries(secrets).map(([name, secret]) => [
              name,
              secret.secretArn,
            ]),
          ),
        ),
        ...(Object.keys(filesystems).length === 0
          ? {}
          : {
              [FILESYSTEM_BUCKETS_VARIABLE]: Stack.of(this).toJsonString(
                Object.fromEntries(
                  Object.entries(filesystems).map(([name, filesystem]) => [
                    name,
                    filesystem.bucket.bucketName,
                  ]),
                ),
              ),
            }),
      },
    });
    // CloudFormation takes PlatformVersion; the CDK does not type it yet
    // (docs/research/agentcore-runtime.md §Platform version V2).
    const cfnRuntime = this.runtime.node.defaultChild as CfnRuntime;
    cfnRuntime.addPropertyOverride('PlatformVersion', 'V2');
    // The runtime's own name, known only once the L2 has named it.
    cfnRuntime.addPropertyOverride(
      `EnvironmentVariables.${METRICS_VARIABLE}`,
      this.runtime.agentRuntimeName,
    );
    // The container URI the L2 renders for the artifact, which binds it
    // (an asset is built there) only as the template is synthesized.
    this.image = Lazy.string({
      produce: () => {
        const artifact = Stack.of(this).resolve(
          cfnRuntime.agentRuntimeArtifact,
        ) as { containerConfiguration?: { containerUri?: string } };
        const containerUri = artifact.containerConfiguration?.containerUri;
        if (containerUri === undefined) {
          throw new Error(
            `runtime ${this.node.path} renders no container URI: a task records the image it runs in, so AgentRuntime takes a container artifact`,
          );
        }
        return containerUri;
      },
    });
    cfnRuntime.addPropertyOverride(
      `EnvironmentVariables.${AGENT_IMAGE_VARIABLE}`,
      this.image,
    );
    Validations.of(cfnRuntime).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason:
        "PlatformVersion is in CloudFormation's resource reference but not yet in the CDK's bundled schema",
    });
    // The whole table: the project's agents are trusted alike, and the task
    // store reads only the agent's own tasks.
    project.taskTable.grantReadWriteData(this.runtime);
    // Transcripts under the agent's own name only, listing included.
    this.runtime.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [project.sessionBucket.arnForObjects(`${agentName}/*`)],
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [project.sessionBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': `${agentName}/*` } },
      }),
    );
    for (const filesystem of Object.values(filesystems)) {
      filesystem.bucket.grantReadWrite(this.runtime);
    }
    // The collector's OTLP metrics are PutMetricData on CloudWatch's default
    // dataset, which the L2 role's namespace-scoped grant does not cover.
    this.runtime.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: [
          Stack.of(this).formatArn({
            service: 'cloudwatch',
            resource: 'dataset',
            resourceName: 'default',
          }),
        ],
      }),
    );
    // What AgentForge counts per agent (§REQ604); PutMetricData takes no
    // resource, so the namespace is the bound.
    this.runtime.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE },
        },
      }),
    );
    for (const secret of Object.values(secrets)) {
      secret.grantRead(this.runtime);
    }
    // AgentCore delivers a new agent's spans to the agent's own log group,
    // and needs its role to let X-Ray write there; the L2 role does not.
    this.runtime.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['logs:PutResourcePolicy'],
        resources: [
          Stack.of(this).formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: `/aws/bedrock-agentcore/runtimes/${this.runtime.agentRuntimeName}-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    project.addAgent({ agentName, runtime: this.runtime, scope: this });
  }

  get agentRuntimeArn(): string {
    return this.runtime.agentRuntimeArn;
  }

  /** Lets a caller invoke this agent, and nothing else (§REQ708). */
  grantInvoke(grantee: IGrantable): Grant {
    return this.runtime.grantInvokeRuntime(grantee);
  }
}
