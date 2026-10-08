import {
  type ContextBlockFunction,
  composeContext,
} from '@beruangai/agentforge/agent';

/**
 * The kata files' protocol, from this layer's `.claude/` — relative to an
 * agent's cwd, its own directory. The same for every run, so a procedure
 * places it after its other static content and before what varies: its
 * cache breakpoint covers both.
 */
const kataFiles: ContextBlockFunction = () => [
  {
    tag: 'protocol',
    name: 'kata-files',
    filepath: '../.claude/fragments/kata-files.md',
    cache: true,
  },
];

/** The directory this run's kata lives in. */
const kataDirectory: ContextBlockFunction<{ directory: string }> = ({
  directory,
}) => [{ tag: 'kata-directory', context: directory }];

/**
 * What every agent in golden-kata is told about a kata: its files' protocol
 * and its directory. Agents import it as
 * `@beruangai/golden-kata-base/context`.
 */
export const kataContext = composeContext(kataFiles, kataDirectory);
