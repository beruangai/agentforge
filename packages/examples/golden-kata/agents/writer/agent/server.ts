// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The container's entry: AgentForge's server, running `task.ts` once per task.
// Everything else comes from the environment.
import { startServer } from '@beruangai/agentforge/server';

await startServer({ taskEntry: new URL('./task.ts', import.meta.url) });
