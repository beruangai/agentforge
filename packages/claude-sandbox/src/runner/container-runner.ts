import type { ContainerRuntime } from './container-runtime.js';
import { extractOutput } from './sentinel.js';
import type {
  AgentForgeContainerInput,
  AgentForgeContainerOutput,
} from './types.js';

const DEFAULT_EXTRA_HOSTS = ['host.docker.internal:host-gateway'];

export interface ContainerRunnerConfig {
  runtime: ContainerRuntime;
  image: string;
  cleanupOnExit: boolean;
  defaultTimeout: number;
}

export interface RunContainerOptions {
  name: string;
  input: AgentForgeContainerInput;
  binds: string[];
  env: string[];
  timeout: number;
  network?: string;
  extraHosts?: string[];
}

export interface ContainerRunResult {
  output: AgentForgeContainerOutput;
  statusCode: number;
}

/**
 * Run a container with the agent-runner, send input via stdin,
 * and extract output via sentinel protocol.
 */
export async function runContainer(
  config: ContainerRunnerConfig,
  options: RunContainerOptions,
): Promise<ContainerRunResult> {
  const { runtime, image, cleanupOnExit } = config;
  const extraHosts = options.extraHosts ?? DEFAULT_EXTRA_HOSTS;

  const containerId = await runtime.createContainer({
    image,
    name: options.name,
    env: options.env,
    binds: options.binds,
    network: options.network,
    extraHosts,
    openStdin: true,
  });

  try {
    // Attach to write stdin before starting
    const { stream } = await runtime.attachContainer(containerId);

    // Start the container
    await runtime.startContainer(containerId);

    // Write input to stdin and close
    const inputJson = JSON.stringify(options.input);
    stream.write(inputJson);
    stream.end();

    // Wait for container to finish (with timeout)
    const waitResult = await runtime.waitContainer(
      containerId,
      options.timeout,
    );

    // Read logs after container exits
    const { stdout, stderr } = await runtime.getContainerLogs(containerId);

    // Try to extract sentinel output
    const output = extractOutput(stdout);

    if (!output) {
      const raw = stderr.trim() || stdout.trim() || 'No output from container';
      const message = raw.length > 2000 ? `...${raw.slice(-2000)}` : raw;
      throw new Error(
        `Sentinel output not found in container stdout (exit code: ${waitResult.StatusCode}): ${message}`,
      );
    }

    return {
      output,
      statusCode: waitResult.StatusCode,
    };
  } finally {
    if (cleanupOnExit) {
      try {
        await runtime.removeContainer(containerId, true);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
