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
  Agent as GraderAgent,
  type AgentProps as GraderAgentProps,
} from './agents/grader/agent.js';
import {
  Agent as WriterAgent,
  type AgentProps as WriterAgentProps,
} from './agents/writer/agent.js';

export interface AgenticProjectProps
  extends Omit<AgenticProjectResourcesProps, 'projectName'> {
  /** Each agent's runtime options, with the secrets it requires; the project's resources are passed to each. */
  readonly agents: {
    readonly writer: Omit<WriterAgentProps, 'project'>;
    readonly grader: Omit<GraderAgentProps, 'project'>;
  };
}

/**
 * golden-kata's agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, sharing one task table, session bucket, dashboard and
 * readiness probe, and the grant a caller of the project needs.
 */
export class AgenticProject extends Construct {
  /** What the project's agents share. */
  readonly resources: AgenticProjectResources;
  readonly agents: {
    readonly writer: WriterAgent;
    readonly grader: GraderAgent;
  };
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, props: AgenticProjectProps) {
    super(scope, id);
    const { agents, ...shared } = props;
    this.resources = new AgenticProjectResources(this, 'Resources', {
      projectName: 'golden-kata',
      ...shared,
    });
    this.agents = {
      writer: new WriterAgent(this, 'Writer', {
        ...agents.writer,
        project: this.resources,
      }),
      grader: new GraderAgent(this, 'Grader', {
        ...agents.grader,
        project: this.resources,
      }),
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
