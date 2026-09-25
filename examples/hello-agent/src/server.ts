// The container's entry: AgentForge's server, running `task.ts` once per task.
// Everything else comes from the environment.
import { startServer } from '@beruangai/agentforge/server';

await startServer({ taskEntry: new URL('./task.ts', import.meta.url) });
