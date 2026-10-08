// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import {
  AgenticProjectResources,
  type AgenticProjectResourcesProps,
} from '@beruangai/agentforge/infra';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '../../../core/runtime-config.js';
import {
  Agent as HelloAgentAgent,
  type AgentProps as HelloAgentAgentProps,
} from './agents/hello-agent/agent.js';

export interface AgenticProjectProps
  extends Omit<AgenticProjectResourcesProps, 'projectName'> {
  /** Each agent's runtime options, with the secrets it requires; the project's resources are passed to each. */
  readonly agents: {
    readonly helloAgent: Omit<HelloAgentAgentProps, 'project'>;
  };
}

/**
 * smoke-coverage's agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, sharing one task table, session bucket, dashboard and
 * readiness probe, and the grant a caller of the project needs.
 */
export class AgenticProject extends Construct {
  /** What the project's agents share. */
  readonly resources: AgenticProjectResources;
  readonly agents: {
    readonly helloAgent: HelloAgentAgent;
  };
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, props: AgenticProjectProps) {
    super(scope, id);
    const { agents, ...shared } = props;
    this.resources = new AgenticProjectResources(this, 'Resources', {
      projectName: 'smoke-coverage',
      ...shared,
    });
    this.agents = {
      helloAgent: new HelloAgentAgent(this, 'HelloAgent', {
        ...agents.helloAgent,
        project: this.resources,
      }),
    };
    this.runtimeConfigApplicationId =
      RuntimeConfig.ensure(this).appConfigApplicationId;
  }

  /** Invocation of exactly this project's agents, and read of the stage's runtime configuration. */
  grantInvoke(grantee: IGrantable): void {
    this.agents.helloAgent.grantInvoke(grantee);
    RuntimeConfig.ensure(this).grantReadAppConfig(grantee);
  }
}
