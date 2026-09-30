// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
export {
  AgenticProject as SmokeCoverage,
  type AgenticProjectProps as SmokeCoverageProps,
} from './project.js';
export {
  Agent as SmokeCoverageHelloAgent,
  type AgentProps as SmokeCoverageHelloAgentProps,
  type Secrets as SmokeCoverageHelloAgentSecrets,
} from './agents/hello-agent/agent.js';
