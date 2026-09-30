/**
 * Local orchestration, agents on AgentCore: the shared local server, the
 * worker the global setup runs, and golden-kata's agents as
 * golden-kata-infra's `deploy` left them.
 */
import { goldenKataWorkflowsSuite } from '../golden-kata-workflows.suite.ts';

goldenKataWorkflowsSuite();
