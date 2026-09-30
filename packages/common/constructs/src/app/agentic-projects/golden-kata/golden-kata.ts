// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '../../../core/runtime-config.js';
import {
  GoldenKataGrader,
  type GoldenKataGraderProps,
} from './agents/grader/grader.js';
import {
  GoldenKataWriter,
  type GoldenKataWriterProps,
} from './agents/writer/writer.js';

export interface GoldenKataProps {
  /** Each agent's runtime options, with the secrets it requires. */
  readonly agents: {
    readonly writer: GoldenKataWriterProps;
    readonly grader: GoldenKataGraderProps;
  };
}

/**
 * golden-kata's agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, and the grant a caller of the project needs.
 */
export class GoldenKata extends Construct {
  readonly agents: {
    readonly writer: GoldenKataWriter;
    readonly grader: GoldenKataGrader;
  };
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, props: GoldenKataProps) {
    super(scope, id);
    this.agents = {
      writer: new GoldenKataWriter(this, 'Writer', props.agents.writer),
      grader: new GoldenKataGrader(this, 'Grader', props.agents.grader),
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
