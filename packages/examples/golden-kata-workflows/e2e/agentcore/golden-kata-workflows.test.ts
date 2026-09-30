/**
 * Everything deployed: the workflow started on Temporal Cloud and run by the
 * worker golden-kata-infra's `deploy` left on ECS, calling golden-kata's
 * agents on AgentCore.
 */
import { goldenKataWorkflowsSuite } from '../golden-kata-workflows.suite.ts';

goldenKataWorkflowsSuite();
