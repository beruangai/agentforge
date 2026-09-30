// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
export {
  AgenticProject as GoldenKata,
  type AgenticProjectProps as GoldenKataProps,
} from './project.js';
export {
  Agent as GoldenKataGrader,
  type AgentProps as GoldenKataGraderProps,
  type Secrets as GoldenKataGraderSecrets,
} from './agents/grader/agent.js';
export {
  Agent as GoldenKataWriter,
  type AgentProps as GoldenKataWriterProps,
  type Secrets as GoldenKataWriterSecrets,
} from './agents/writer/agent.js';
