// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '../../../core/runtime-config.js';
import {
  Agent as GraderAgent,
  type AgentProps as GraderAgentProps,
} from './agents/grader/agent.js';
import {
  Agent as WriterAgent,
  type AgentProps as WriterAgentProps,
} from './agents/writer/agent.js';

export interface AgenticProjectProps {
  /** Each agent's runtime options, with the secrets it requires. */
  readonly agents: {
    readonly writer: WriterAgentProps;
    readonly grader: GraderAgentProps;
  };
}

/**
 * golden-kata's agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, and the grant a caller of the project needs.
 */
export class AgenticProject extends Construct {
  readonly agents: {
    readonly writer: WriterAgent;
    readonly grader: GraderAgent;
  };
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, props: AgenticProjectProps) {
    super(scope, id);
    this.agents = {
      writer: new WriterAgent(this, 'Writer', props.agents.writer),
      grader: new GraderAgent(this, 'Grader', props.agents.grader),
    };
    this.runtimeConfigApplicationId =
      RuntimeConfig.ensure(this).appConfigApplicationId;
  }

  /** Invocation of exactly this project's agents, and read of the stage's runtime configuration. */
  grantInvoke(grantee: IGrantable): void {
    this.agents.writer.grantInvoke(grantee);
    this.agents.grader.grantInvoke(grantee);
    RuntimeConfig.ensure(this).grantReadAppConfig(grantee);
  }
}
