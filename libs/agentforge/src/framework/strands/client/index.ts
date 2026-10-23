/**
 * `@beruangai/agentforge/strands/client` — what a caller of a `strands`
 * project's agents may read beside `/client`: a run's session. Importable
 * anywhere; the SDK loads only when a session is read.
 */
export { readSession } from './session.ts';
