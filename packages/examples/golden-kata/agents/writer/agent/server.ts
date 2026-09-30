// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The container's entry: AgentForge's server, running `task.ts` once per task
// and requiring the secrets this project's layers declare. Everything else
// comes from the environment.
import { startServer } from '@beruangai/agentforge/server';
import { REQUIRED_SECRETS as PROJECT_SECRETS } from '@beruangai/golden-kata-base/secrets';
import { REQUIRED_SECRETS as AGENT_SECRETS } from './secrets.ts';

await startServer({
  taskEntry: new URL('./task.ts', import.meta.url),
  requiredSecrets: [...PROJECT_SECRETS, ...AGENT_SECRETS],
});
