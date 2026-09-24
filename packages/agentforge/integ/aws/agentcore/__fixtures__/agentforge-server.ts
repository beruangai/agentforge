// AgentForge's own server, as an agent's image starts it: configured from the
// environment the runtime is created with.
import { startServer } from '../../../../src/server/runtime/server.ts';

await startServer();
