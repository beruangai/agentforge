// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
export {
  AgenticProject as ResearchBrief,
  type AgenticProjectProps as ResearchBriefProps,
} from './project.js';
export {
  Agent as ResearchBriefBriefer,
  type AgentProps as ResearchBriefBrieferProps,
  type Secrets as ResearchBriefBrieferSecrets,
} from './agents/briefer/agent.js';
