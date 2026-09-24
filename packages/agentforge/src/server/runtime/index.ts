/**
 * `@beruangai/agentforge/server` — the container's server: A2A 1.0 on
 * AgentCore's contract, a process per task, task state in DynamoDB. Started
 * by the consumer's server entry; it never loads a procedure itself.
 */
export {
  type RunningServer,
  type ServerConfig,
  serverConfigFromEnvironment,
  startServer,
} from './server.ts';
export { createTaskTable, DynamoDBTaskStore } from './task-store.ts';
