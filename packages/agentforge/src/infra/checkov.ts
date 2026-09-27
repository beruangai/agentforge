import { CfnResource } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/**
 * Records on a construct's CloudFormation resource that checkov should skip
 * these checks, and why — so a consumer's checkov inherits the reasons for
 * what AgentForge's constructs chose, as `@aws/nx-plugin`'s `suppressRules`
 * does.
 */
export function suppressRules(
  construct: IConstruct,
  ids: readonly string[],
  comment: string,
): void {
  const resource = CfnResource.isCfnResource(construct)
    ? construct
    : construct.node.defaultChild;
  if (!CfnResource.isCfnResource(resource)) {
    throw new Error(
      `${construct.node.path} has no CloudFormation resource to annotate`,
    );
  }
  const metadata = (resource.getMetadata('checkov') ?? {}) as {
    skip?: { id: string; comment: string }[];
  };
  resource.addMetadata('checkov', {
    ...metadata,
    skip: [...(metadata.skip ?? []), ...ids.map((id) => ({ id, comment }))],
  });
}
