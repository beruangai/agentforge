// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The worker's entry: AgentForge's worker polling the project's task queue
// with its workflows, bundled before it starts, its own activities and every
// connected agentic project's, requiring the secrets secrets.ts declares.
// The Temporal connection, and how agents are reached, come from the
// environment.
import { runWorker } from '@beruangai/agentforge/temporal';
import { activities } from './activities/index.ts';
import { agentActivities } from './agents/activities.ts';
import { TASK_QUEUE } from './client.ts';
import { REQUIRED_SECRETS } from './secrets.ts';

await runWorker({
  taskQueue: TASK_QUEUE,
  workflowBundle: new URL('./workflows.js', import.meta.url),
  activities,
  agentActivities: await agentActivities(),
  requiredSecrets: REQUIRED_SECRETS,
});
