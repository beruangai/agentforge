import { spawn } from 'node:child_process';

/** How one child run ended. */
export interface ChildResult {
  readonly exitCode: number;
  /** Everything it wrote to stdout, when captured; otherwise empty. */
  readonly stdout: string;
  /** The end of what it wrote to stderr, redacted. */
  readonly stderr: string;
  /** Whether it was killed for running past its bound. */
  readonly timedOut: boolean;
}

export interface ChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Its whole environment; the task process's when absent. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Written to its stdin, which is otherwise closed. */
  readonly input?: string | undefined;
  /** Captures stdout for the caller; otherwise the task's log gets it. */
  readonly captureStdout?: boolean;
  /** Also writes its stderr, redacted, to the task's log as it arrives. */
  readonly echoStderr?: boolean;
  /** Kills it after this long, reporting it timed out. */
  readonly timeoutSeconds?: number;
  /** Applied to its stderr before it is logged or returned: a secret never leaves. */
  readonly redact?: (text: string) => string;
  /** Why the binary is missing, and where it comes from. */
  readonly missing: string;
}

/** How much of a child's stderr a failure carries. */
const STDERR_TAIL_CHARACTERS = 2_000;

/**
 * Runs a binary as a child of the task process, never through a shell, so a
 * cancel or a lost container takes it and no argument is interpreted.
 */
export function runChild(spec: ChildSpec): Promise<ChildResult> {
  const redact = spec.redact ?? ((text: string) => text);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [
        spec.input === undefined ? 'ignore' : 'pipe',
        spec.captureStdout === true ? 'pipe' : 'inherit',
        'pipe',
      ],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      spec.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, spec.timeoutSeconds * 1000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (spec.echoStderr === true) process.stderr.write(redact(text));
      stderr = (stderr + text).slice(-STDERR_TAIL_CHARACTERS * 2);
    });
    if (spec.input !== undefined) child.stdin?.end(spec.input);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error(`${spec.command} is not on the PATH: ${spec.missing}`)
          : error,
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = redact(stderr).slice(-STDERR_TAIL_CHARACTERS);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr: signal === null ? tail : `${tail}\nkilled by ${signal}`,
        timedOut,
      });
    });
  });
}
