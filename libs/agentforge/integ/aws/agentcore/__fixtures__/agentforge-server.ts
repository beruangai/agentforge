// AgentForge's own server, as an agent's image starts it: its task entry
// named here, the rest from the environment the runtime is created with.
import { startServer } from '../../../../src/server/runtime/server.ts';

await startServer({
  taskEntry: new URL(
    '../../../local/runtime/__fixtures__/task-entry.ts',
    import.meta.url,
  ),
  requiredSecrets: [],
});
