/**
 * The marketplace at the repository root and its plugin, as Claude Code
 * validates them (§REQ712). A malformed manifest fails here rather than at a
 * developer's session start. The validator does not check that the plugin's
 * source exists (CLI 2.1.280); `enabled-per-project.test.ts` catches that.
 *
 * The plugin declares no `version`, which the validator warns about: it loads
 * in place from a developer's clone, so a version would only gate updates
 * from a git source, which AgentForge does not use.
 */
import { describe, expect, it } from 'vitest';
import { claudeCodeExecutable } from '../../__fixtures__/claude-cli.ts';
import { runCommand } from '../../__fixtures__/run-command.ts';
import {
  PLUGIN_DIRECTORY,
  REPOSITORY_ROOT,
} from './__fixtures__/repository.ts';

describe('the agentforge marketplace', () => {
  it.each([
    ['the marketplace', REPOSITORY_ROOT],
    ['the plugin', PLUGIN_DIRECTORY],
  ])('%s validates', async (subject, path) => {
    const { stdout } = await runCommand(
      claudeCodeExecutable(),
      ['plugin', 'validate', path],
      { purpose: `validating ${subject}` },
    );
    expect(stdout).toContain('Validation passed');
  });
});
