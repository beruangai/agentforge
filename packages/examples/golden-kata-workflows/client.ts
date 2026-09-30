// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// How a caller starts golden-kata-workflows's workflows: the task queue its worker
// polls, and a Temporal client connected as the environment names it.
import { connectTemporalClient } from '@beruangai/agentforge/temporal';
import type { Client } from '@temporalio/client';

/** The one task queue the project's worker polls. */
export const TASK_QUEUE = 'beruangai-golden-kata-workflows';

/** A client from TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE and, for Temporal Cloud, TEMPORAL_API_KEY. */
export const connectClient = (): Promise<Client> => connectTemporalClient();
