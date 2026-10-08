import { fileURLToPath } from 'node:url';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import {
  Dashboard,
  GraphWidget,
  Metric,
  TextWidget,
} from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  Code,
  Function as LambdaFunction,
  Runtime as LambdaRuntime,
  RuntimeFamily,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AGENT_NAME_PATTERN } from '#core/agent-name.ts';
import {
  METRICS_DIMENSION,
  METRICS_NAMESPACE,
  OPERATIONAL_METRICS,
} from '#core/metrics.ts';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { suppressRules } from './checkov.ts';

/**
 * How long the probe may wait for a runtime to serve: a V2 create takes
 * minutes while the snapshot is prepared (~184 s observed), and Lambda's
 * ceiling is fifteen.
 */
const READINESS_TIMEOUT = Duration.minutes(14);
/**
 * Lambda's Node.js 26 runtime, in public preview until its GA (targeted for
 * November 2026), before which the CDK has no member for it
 * (docs/research/agentcore-runtime.md). Node 26 gives the probe uuid7.
 */
const NODEJS_26_X = new LambdaRuntime('nodejs26.x', RuntimeFamily.NODEJS);

export interface AgenticProjectResourcesProps {
  /** Titles the dashboard. */
  readonly projectName: string;
  /**
   * What happens to the task table and the session bucket when the stack
   * deletes them. `DESTROY` deletes the bucket only when it is empty, and
   * fails the stack's deletion otherwise: emptying it would take a Lambda
   * whose log group outlives the stack.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * How long a session's transcript is kept after it is written (§REQ402),
   * for every agent of the project. Transcripts hold everything the agent was
   * sent and read.
   * @default Duration.days(30)
   */
  readonly sessionRetention?: Duration;
}

/** An agent of the project, as `AgentRuntime` adds it. */
export interface AgenticProjectAgent {
  /** The agent's name within its project, which its tasks and transcripts are scoped by. */
  readonly agentName: string;
  readonly runtime: Runtime;
  /** Where the agent's own readiness check is created, so removing the agent removes it. */
  readonly scope: Construct;
}

/**
 * What an agentic project's agents share: the DynamoDB table their tasks live
 * in, the S3 bucket their session transcripts persist in — each agent's under
 * its own name — so a session outlives its container, one dashboard with a
 * section per agent (§REQ604), and one readiness probe that holds a deploy
 * until each agent serves. Its agents are trusted alike: each is granted the
 * whole table, and the task store scopes what an agent reads to its own
 * tasks.
 */
export class AgenticProjectResources extends Construct {
  readonly taskTable: Table;
  readonly sessionBucket: Bucket;
  /** Each agent's operational metrics beside what AgentCore reports of it. */
  readonly dashboard: Dashboard;
  readonly #probe: LambdaFunction;
  readonly #agentNames = new Set<string>();

  constructor(
    scope: Construct,
    id: string,
    props: AgenticProjectResourcesProps,
  ) {
    super(scope, id);
    const {
      projectName,
      removalPolicy = RemovalPolicy.RETAIN,
      sessionRetention = Duration.days(30),
    } = props;

    this.taskTable = new Table(this, 'TaskTable', {
      partitionKey: {
        name: TASK_TABLE_PARTITION_KEY,
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    this.sessionBucket = new Bucket(this, 'SessionBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // A transcript is gone a day after it expires: versioning is an undo
      // window, not a second retention.
      lifecycleRules: [
        {
          expiration: sessionRetention,
          noncurrentVersionExpiration: Duration.days(1),
        },
        // S3 refuses this beside an expiration, so it is a rule of its own.
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy,
    });
    suppressRules(
      this.sessionBucket,
      ['CKV_AWS_18'],
      "Only the project's agents read and write transcripts, each under its own name; the run record and the task store are the audit, not S3 access logs.",
    );

    this.dashboard = new Dashboard(this, 'Dashboard');
    this.dashboard.addWidgets(
      new TextWidget({
        markdown: `# ${projectName}\nWhat AgentForge cannot rule out, beside what AgentCore reports, for each agent.`,
        width: 24,
        height: 2,
      }),
    );

    this.#probe = new LambdaFunction(this, 'ReadinessProbe', {
      runtime: NODEJS_26_X,
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
  }

  /**
   * `AgentRuntime`'s, called once per agent: adds the agent's dashboard
   * section, titled by its name, and its readiness check, granting the probe
   * the runtime. Refuses a name already added, so two agents never share
   * the scope of their tasks and transcripts.
   */
  addAgent(agent: AgenticProjectAgent): void {
    const { agentName, runtime, scope } = agent;
    if (!AGENT_NAME_PATTERN.test(agentName)) {
      throw new Error(
        `agent name "${agentName}" must match ${AGENT_NAME_PATTERN}`,
      );
    }
    if (this.#agentNames.has(agentName)) {
      throw new Error(
        `the project already has an agent named "${agentName}"; each agent's tasks and transcripts are scoped by its name`,
      );
    }
    this.#agentNames.add(agentName);
    addAgentSection(this.dashboard, agentName, runtime);

    const agentRuntimeVersion = runtime.agentRuntimeVersion;
    if (agentRuntimeVersion === undefined) {
      throw new Error('the L2 Runtime exposes no agentRuntimeVersion');
    }
    const probeGrant = runtime.grantInvokeRuntime(this.#probe);
    // The probe is its own handler; a new version updates the resource, so
    // every deploy that changes the runtime waits for it to serve again.
    const readiness = new CustomResource(scope, 'Readiness', {
      serviceToken: this.#probe.functionArn,
      resourceType: 'Custom::AgentForgeReadiness',
      // A probe that never answers — one that fails to load — fails the
      // deploy once the probe's own timeout has passed, not after an hour.
      serviceTimeout: READINESS_TIMEOUT.plus(Duration.minutes(1)),
      properties: {
        AgentRuntimeArn: runtime.agentRuntimeArn,
        AgentRuntimeVersion: agentRuntimeVersion,
      },
    });
    readiness.node.addDependency(probeGrant);
  }
}

/**
 * An agent's section of the project's dashboard (§REQ604): what AgentForge
 * counts, beside the invocations, errors, latency, sessions and resources
 * AgentCore reports of the runtime's default endpoint.
 */
function addAgentSection(
  dashboard: Dashboard,
  agentName: string,
  runtime: Runtime,
): void {
  const runtimeName = runtime.agentRuntimeName;
  const runtimeArn = runtime.agentRuntimeArn;
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
  dashboard.addWidgets(
    new TextWidget({
      markdown: `## ${agentName}\nRuntime \`${runtimeName}\`.`,
      width: 24,
      height: 1,
    }),
  );
  dashboard.addWidgets(
    new GraphWidget({
      title: `${agentName}: tasks AgentForge could not settle`,
      left: Object.values(OPERATIONAL_METRICS).map(counted),
      width: 12,
    }),
    new GraphWidget({
      title: `${agentName}: invocations and errors`,
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
      title: `${agentName}: latency`,
      left: [invocation('Latency', 'Average'), invocation('Latency', 'p99')],
      width: 8,
    }),
    new GraphWidget({
      title: `${agentName}: sessions`,
      left: [invocation('Sessions')],
      width: 8,
    }),
    new GraphWidget({
      title: `${agentName}: resources`,
      left: [usage('MemoryUsed-GBHours')],
      right: [usage('CPUUsed-vCPUHours')],
      width: 8,
    }),
  );
}
