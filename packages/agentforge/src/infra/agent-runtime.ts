import { fileURLToPath } from 'node:url';
import {
  CustomResource,
  Duration,
  RemovalPolicy,
  Validations,
} from 'aws-cdk-lib';
import {
  type CfnRuntime,
  ProtocolType,
  Runtime,
  type RuntimeProps,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Grant, IGrantable } from 'aws-cdk-lib/aws-iam';
import {
  Code,
  Function as LambdaFunction,
  Runtime as LambdaRuntime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';

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
   * What happens to the task table when the stack deletes it.
   * @default RemovalPolicy.RETAIN
   */
  readonly taskTableRemovalPolicy?: RemovalPolicy;
}

/**
 * One deployed agent: an AgentCore runtime on platform version V2 serving the
 * agent's image over A2A, and the DynamoDB table its tasks live in. A deploy
 * completes only once the runtime serves: a readiness probe runs after every
 * change to the runtime, asking it for an unknown task until AgentForge's
 * server answers. Everything else a runtime takes — its image, role, network,
 * lifecycle, environment — is the consumer's, as the L2 `Runtime` takes it;
 * the A2A-Version header and the table's name are added to what it declares.
 */
export class AgentRuntime extends Construct {
  readonly runtime: Runtime;
  readonly taskTable: Table;

  constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
    super(scope, id);
    const {
      taskTableRemovalPolicy = RemovalPolicy.RETAIN,
      environmentVariables = {},
      requestHeaderConfiguration,
      ...runtimeProps
    } = props;
    if (TABLE_NAME_VARIABLE in environmentVariables) {
      throw new Error(
        `${TABLE_NAME_VARIABLE} is set by AgentRuntime to its own task table; remove it from environmentVariables`,
      );
    }

    this.taskTable = new Table(this, 'TaskTable', {
      partitionKey: {
        name: TASK_TABLE_PARTITION_KEY,
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: taskTableRemovalPolicy,
    });

    const allowlistedHeaders =
      requestHeaderConfiguration?.allowlistedHeaders ?? [];
    this.runtime = new Runtime(this, 'Runtime', {
      ...runtimeProps,
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
      },
    });
    // CloudFormation takes PlatformVersion; the CDK does not type it yet
    // (docs/research/agentcore-runtime.md §Platform version V2).
    const cfnRuntime = this.runtime.node.defaultChild as CfnRuntime;
    cfnRuntime.addPropertyOverride('PlatformVersion', 'V2');
    Validations.of(cfnRuntime).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason:
        "PlatformVersion is in CloudFormation's resource reference but not yet in the CDK's bundled schema",
    });
    this.taskTable.grantReadWriteData(this.runtime);

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
