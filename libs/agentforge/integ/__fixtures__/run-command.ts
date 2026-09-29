import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunCommandOptions {
  /** What the command is for, so a failure says which step broke. */
  readonly purpose: string;
  readonly workingDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * `execFile`, rethrowing a failure with the purpose, the command line and the
 * command's own output, so a broken step names itself instead of surfacing as a
 * bare exit code.
 */
export async function runCommand(
  command: string,
  commandArguments: readonly string[],
  options: RunCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, commandArguments, {
      cwd: options.workingDirectory,
      env: options.environment ?? process.env,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${options.purpose}: \`${[command, ...commandArguments].join(' ')}\` failed\n--- stderr ---\n${stderr ?? ''}\n--- stdout ---\n${stdout ?? ''}`,
      { cause: error },
    );
  }
}
