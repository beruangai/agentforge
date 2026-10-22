/**
 * `@beruangai/agentforge/claude/client` — what a caller of a `claude`
 * project's agents may read beside `/client`: a run's transcript. Importable
 * anywhere; the Agent SDK loads only when a transcript is read.
 */
export { readTranscript } from './transcript.ts';
