import { fileURLToPath } from 'node:url';
import {
  ArnFormat,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
} from 'aws-cdk-lib';
import {
  type CfnRuntime,
  ProtocolType,
  Runtime,
  type RuntimeProps,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import {
  Dashboard,
  GraphWidget,
  Metric,
  TextWidget,
} from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  type Grant,
  type IGrantable,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import {
  Code,
  Function as LambdaFunction,
  Runtime as LambdaRuntime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  METRICS_DIMENSION,
  METRICS_NAMESPACE,
  METRICS_VARIABLE,
  OPERATIONAL_METRICS,
} from '#core/metrics.ts';
import { SECRETS_VARIABLE } from '#core/secrets.ts';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { TELEMETRY_VARIABLE, type TelemetryLevel } from '#core/telemetry.ts';
import {
  WORKING_DIRECTORIES_VARIABLE,
  WORKING_DIRECTORY_NAME_PATTERN,
} from '#core/working-directory.ts';
import type { WorkingDirectory } from './working-directory.ts';

/** The one request header AgentForge relies on AgentCore forwarding (ADR 0014). */
const A2A_VERSION_HEADER = 'A2A-Version';
/** Set by the construct: where the server keeps task state. */
const TABLE_NAME_VARIABLE = 'AGENTFORGE_TABLE_NAME';
/**
 * How long the probe may wait for the runtime to serve: a V2 create takes
 * minutes while the snapshot is prepared (~184 s observed), and Lambda's
 * ceiling is fifteen.
 */
const READINESS_TIMEOUT = Duration.minutes(14);

export interface AgentRuntimeProps
  extends Omit<RuntimeProps, 'protocolConfiguration'> {
  /**
   * What happens to the task table and the session bucket when the stack
   * deletes them. `DESTROY` deletes the bucket only when it is empty, and
   * fails the stack's deletion otherwise: emptying it would take a Lambda
   * whose log group outlives the stack.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * How long a session's transcript is kept after it is written (§REQ402).
   * Transcripts hold everything the agent was sent and read.
   * @default Duration.days(30)
   */
  readonly sessionRetention?: Duration;
  /**
   * Whether the runtime delivers its service spans to AgentCore Observability.
   * @default true
   */
  readonly tracingEnabled?: boolean;
  /**
   * Secrets the agent reads, by the environment variable each becomes — the
   * subscription token as `CLAUDE_CODE_OAUTH_TOKEN`. The runtime may read
   * these and no others (§REQ705); the server reads them at startup. A
   * stopgap until AgentCore Identity holds them.
   */
  readonly secrets?: Readonly<
    Record<string, Pick<ISecret, 'secretArn' | 'grantRead'>>
  >;
  /**
   * How much of the Claude CLI's telemetry the agent exports to CloudWatch,
   * as a log level: `WARN`, metrics and error events; `INFO`, every event
   * and trace, no content; `DEBUG`, prompts and tool content too; `ALL`, the
   * raw API bodies too.
   * @default 'INFO'
   */
  readonly telemetry?: TelemetryLevel;
  /**
   * The working directories the agent's procedures may open, by the name
   * they open each by. A working directory may be given to several agents.
   */
  readonly workingDirectories?: Readonly<Record<string, WorkingDirectory>>;
}

/**
 * One deployed agent: an AgentCore runtime on platform version V2 serving the
 * agent's image over A2A, the DynamoDB table its tasks live in, and the S3
 * bucket its session transcripts persist in, so a session outlives its
 * container — encrypted, private, expired after `sessionRetention`. A deploy
 * completes only once the runtime serves: a readiness probe runs after every
 * change to the runtime, asking it for an unknown task until AgentForge's
 * server answers. Everything else a runtime takes — its image, role, network,
 * lifecycle, environment — is the consumer's, as the L2 `Runtime` takes it;
 * the A2A-Version header and the table's name are added to what it declares.
 * AgentCore Observability is on unless the consumer turns it off: the runtime
 * delivers its service spans, which needs CloudWatch Transaction Search in the
 * account (a one-time setup).
 */
export class AgentRuntime extends Construct {
  readonly runtime: Runtime;
  readonly taskTable: Table;
  readonly sessionBucket: Bucket;
  /** The agent's operational metrics beside what AgentCore reports of it (§REQ604). */
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
    super(scope, id);
    const {
      removalPolicy = RemovalPolicy.RETAIN,
      sessionRetention = Duration.days(30),
      tracingEnabled = true,
      secrets = {},
      telemetry = 'INFO',
      workingDirectories = {},
      environmentVariables = {},
      requestHeaderConfiguration,
      ...runtimeProps
    } = props;
    for (const owned of [
      TABLE_NAME_VARIABLE,
      SESSION_BUCKET_VARIABLE,
      METRICS_VARIABLE,
      SECRETS_VARIABLE,
      TELEMETRY_VARIABLE,
      WORKING_DIRECTORIES_VARIABLE,
    ]) {
      if (owned in environmentVariables) {
        throw new Error(
          `${owned} is set by AgentRuntime; remove it from environmentVariables`,
        );
      }
    }
    for (const name of Object.keys(workingDirectories)) {
      if (!WORKING_DIRECTORY_NAME_PATTERN.test(name)) {
        throw new Error(
          `working directory name "${name}" must match ${WORKING_DIRECTORY_NAME_PATTERN}`,
        );
      }
    }
    for (const name of Object.keys(secrets)) {
      if (name in environmentVariables) {
        throw new Error(
          `${name} is declared both as a secret and in environmentVariables`,
        );
      }
    }

    this.taskTable = new Table(this, 'TaskTable', {
      partitionKey: {
        name: TASK_TABLE_PARTITION_KEY,
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });
    this.sessionBucket = new Bucket(this, 'SessionBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: sessionRetention }],
      removalPolicy,
    });

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
        [TABLE_NAME_VARIABLE]: this.taskTable.tableName,
        [SESSION_BUCKET_VARIABLE]: this.sessionBucket.bucketName,
        [TELEMETRY_VARIABLE]: telemetry,
        ...(Object.keys(secrets).length === 0
          ? {}
          : {
              [SECRETS_VARIABLE]: Stack.of(this).toJsonString(
                Object.fromEntries(
                  Object.entries(secrets).map(([name, secret]) => [
                    name,
                    secret.secretArn,
                  ]),
                ),
              ),
            }),
        ...(Object.keys(workingDirectories).length === 0
          ? {}
          : {
              [WORKING_DIRECTORIES_VARIABLE]: Stack.of(this).toJsonString(
                Object.fromEntries(
                  Object.entries(workingDirectories).map(
                    ([name, directory]) => [name, directory.bucket.bucketName],
                  ),
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
    Validations.of(cfnRuntime).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason:
        "PlatformVersion is in CloudFormation's resource reference but not yet in the CDK's bundled schema",
    });
    this.taskTable.grantReadWriteData(this.runtime);
    this.sessionBucket.grantReadWrite(this.runtime);
    for (const directory of Object.values(workingDirectories)) {
      directory.bucket.grantReadWrite(this.runtime);
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
    this.dashboard = operationalDashboard(
      this,
      this.runtime.agentRuntimeName,
      this.runtime.agentRuntimeArn,
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

    const agentRuntimeVersion = this.runtime.agentRuntimeVersion;
    if (agentRuntimeVersion === undefined) {
      throw new Error('the L2 Runtime exposes no agentRuntimeVersion');
    }
    const probe = new LambdaFunction(this, 'ReadinessProbe', {
      runtime: LambdaRuntime.NODEJS_24_X,
      handler: 'index.handler',
      code: Code.fromAsset(
        fileURLToPath(new URL('./readiness-probe/', import.meta.url)),
      ),
      timeout: READINESS_TIMEOUT,
      // Owned by the stack, so a destroy leaves no log group behind.
      logGroup: new LogGroup(this, 'ReadinessProbeLogs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    const probeGrant = this.runtime.grantInvokeRuntime(probe);
    // The probe is its own handler; a new version updates the resource, so
    // every deploy that changes the runtime waits for it to serve again.
    const readiness = new CustomResource(this, 'Readiness', {
      serviceToken: probe.functionArn,
      resourceType: 'Custom::AgentForgeReadiness',
      properties: {
        AgentRuntimeArn: this.runtime.agentRuntimeArn,
        AgentRuntimeVersion: agentRuntimeVersion,
      },
    });
    readiness.node.addDependency(probeGrant);
  }

  get agentRuntimeArn(): string {
    return this.runtime.agentRuntimeArn;
  }

  /** Lets a caller invoke this agent, and nothing else (§REQ708). */
  grantInvoke(grantee: IGrantable): Grant {
    return this.runtime.grantInvokeRuntime(grantee);
  }
}

/**
 * One dashboard per agent (§REQ604): what AgentForge counts, beside the
 * invocations, errors, latency, sessions and resources AgentCore reports of
 * the runtime's default endpoint.
 */
function operationalDashboard(
  scope: Construct,
  runtimeName: string,
  runtimeArn: string,
): Dashboard {
  const counted = (metricName: string): Metric =>
    new Metric({
      namespace: METRICS_NAMESPACE,
      metricName,
      dimensionsMap: { [METRICS_DIMENSION]: runtimeName },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });
  const endpoint = `${runtimeName}::DEFAULT`;
  const invocation = (metricName: string, statistic = 'Sum'): Metric =>
    new Metric({
      namespace: 'AWS/Bedrock-AgentCore',
      metricName,
      dimensionsMap: {
        Resource: runtimeArn,
        Operation: 'InvokeAgentRuntime',
        Name: endpoint,
      },
      statistic,
      period: Duration.minutes(5),
    });
  const usage = (metricName: string): Metric =>
    new Metric({
      namespace: 'AWS/Bedrock-AgentCore',
      metricName,
      dimensionsMap: {
        Resource: runtimeArn,
        Service: 'AgentCore.Runtime',
        Name: endpoint,
      },
      statistic: 'Sum',
      period: Duration.hours(1),
    });
  const dashboard = new Dashboard(scope, 'Dashboard');
  dashboard.addWidgets(
    new TextWidget({
      markdown: `# ${runtimeName}\nWhat AgentForge cannot rule out, beside what AgentCore reports.`,
      width: 24,
      height: 2,
    }),
  );
  dashboard.addWidgets(
    new GraphWidget({
      title: 'Tasks AgentForge could not settle',
      left: Object.values(OPERATIONAL_METRICS).map(counted),
      width: 12,
    }),
    new GraphWidget({
      title: 'Invocations and errors',
      left: [
        invocation('Invocations'),
        invocation('SystemErrors'),
        invocation('UserErrors'),
        invocation('Throttles'),
      ],
      width: 12,
    }),
  );
  dashboard.addWidgets(
    new GraphWidget({
      title: 'Latency',
      left: [invocation('Latency', 'Average'), invocation('Latency', 'p99')],
      width: 8,
    }),
    new GraphWidget({
      title: 'Sessions',
      left: [invocation('Sessions')],
      width: 8,
    }),
    new GraphWidget({
      title: 'Resources',
      left: [usage('MemoryUsed-GBHours')],
      right: [usage('CPUUsed-vCPUHours')],
      width: 8,
    }),
  );
  return dashboard;
}
