// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '../../../core/runtime-config.js';
import {
  SmokeCoverageHelloAgent,
  type SmokeCoverageHelloAgentProps,
} from './agents/hello-agent/hello-agent.js';

export interface SmokeCoverageProps {
  /** Each agent's runtime options, with the secrets it requires. */
  readonly agents: {
    readonly helloAgent: SmokeCoverageHelloAgentProps;
  };
}

/**
 * smoke-coverage's agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, and the grant a caller of the project needs.
 */
export class SmokeCoverage extends Construct {
  readonly agents: {
    readonly helloAgent: SmokeCoverageHelloAgent;
  };
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, props: SmokeCoverageProps) {
    super(scope, id);
    this.agents = {
      helloAgent: new SmokeCoverageHelloAgent(
        this,
        'HelloAgent',
        props.agents.helloAgent,
      ),
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
