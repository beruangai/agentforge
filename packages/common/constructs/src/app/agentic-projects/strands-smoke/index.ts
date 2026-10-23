// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
export {
  AgenticProject as StrandsSmoke,
  type AgenticProjectProps as StrandsSmokeProps,
} from './project.js';
export {
  Agent as StrandsSmokeHelloAgent,
  type AgentProps as StrandsSmokeHelloAgentProps,
  type Secrets as StrandsSmokeHelloAgentSecrets,
} from './agents/hello-agent/agent.js';
