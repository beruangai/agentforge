/**
 * The local Temporal server, the worker served against it with the agents
 * in their local containers — `temporal-server`, `serve:local`, and
 * golden-kata's `serve-writer` and `serve-grader`.
 */
import { goldenKataWorkflowsSuite } from '../golden-kata-workflows.suite.ts';

goldenKataWorkflowsSuite();
