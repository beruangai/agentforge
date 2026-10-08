/**
 * The registration route (§REQ712, ADR 0019): the marketplace registered once
 * per machine at user scope from the repository root, with the plugin disabled
 * there, loads the skill only in a project that enables it. AgentForge's
 * documented setup rests on it, and a CLI release can change it
 * (docs/research/claude-code-plugin-distribution.md).
 *
 * No model call and no credential: each session is read at its start, from the
 * `initialize` response, where a plugin's skill is listed as
 * `<plugin>:<skill>` (see `readSessionStartWithoutATurn`). It also catches a
 * marketplace source that is not there, which `claude plugin validate` passes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createEnvironmentWithoutCredentials,
  createSandbox,
  QueryRecording,
  readSessionStartWithoutATurn,
  type Sandbox,
} from '../../__fixtures__/claude-agent-sdk.ts';
import { claudeCodeExecutable } from '../../__fixtures__/claude-cli.ts';
import { runCommand } from '../../__fixtures__/run-command.ts';
import { REPOSITORY_ROOT } from './__fixtures__/repository.ts';

const PLUGIN = 'agentforge@agentforge';
const SKILL_COMMAND = 'agentforge:agentforge';

describe('the agentforge plugin, registered per machine and enabled per project', () => {
  let sandbox: Sandbox;
  let environment: Record<string, string | undefined>;

  beforeAll(async () => {
    sandbox = createSandbox('claude-plugin');
    environment = createEnvironmentWithoutCredentials(sandbox.configDirectory);
    await runCommand(
      claudeCodeExecutable(),
      ['plugin', 'marketplace', 'add', REPOSITORY_ROOT, '--scope', 'user'],
      {
        purpose: 'registering the marketplace at user scope',
        workingDirectory: sandbox.workingDirectory,
        environment,
      },
    );
    const userSettingsPath = join(sandbox.configDirectory, 'settings.json');
    const userSettings = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    writeFileSync(
      userSettingsPath,
      JSON.stringify({ ...userSettings, enabledPlugins: { [PLUGIN]: false } }),
    );
    return () => sandbox.dispose();
  });

  async function skillCommandsOfAProject(
    name: string,
    projectSettings: object | undefined,
  ): Promise<string[]> {
    const project = join(sandbox.workingDirectory, name);
    mkdirSync(join(project, '.claude'), { recursive: true });
    if (projectSettings !== undefined) {
      writeFileSync(
        join(project, '.claude/settings.json'),
        JSON.stringify(projectSettings),
      );
    }
    const recording = new QueryRecording('claude-plugin', name);
    const { initializationResult } = await readSessionStartWithoutATurn(
      {
        cwd: project,
        env: environment,
        settingSources: ['user', 'project', 'local'],
      },
      recording,
      false,
    );
    expect(initializationResult.account.tokenSource).toBe('none');
    return initializationResult.commands.map((command) => command.name);
  }

  it('loads the skill in a project that enables the plugin', async () => {
    const commands = await skillCommandsOfAProject('enabled', {
      enabledPlugins: { [PLUGIN]: true },
    });
    expect(commands).toContain(SKILL_COMMAND);
  });

  it('does not load it in a project that does not', async () => {
    const commands = await skillCommandsOfAProject('not-enabled', undefined);
    expect(commands).not.toContain(SKILL_COMMAND);
  });
});
