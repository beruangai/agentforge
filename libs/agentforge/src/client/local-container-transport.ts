import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localTransport, type Transport } from './transport.ts';

/** The agent's contract port inside its container, as `docker port` names it. */
const AGENT_CONTAINER_PORT = '9000/tcp';
/** Hosts Docker publishes on for every interface, reached here through loopback. */
const LOOPBACK_BY_UNSPECIFIED_HOST: Readonly<Record<string, string>> = {
  '0.0.0.0': '127.0.0.1',
  '[::]': '[::1]',
};

const execFileAsync = promisify(execFile);

/** The URL of the first address `docker port` lists, such as `127.0.0.1:55001`. */
function publishedUrl(containerName: string, stdout: string): string {
  const address = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (address === undefined) {
    throw new Error(
      `container ${containerName} publishes no port for ${AGENT_CONTAINER_PORT}`,
    );
  }
  const separator = address.lastIndexOf(':');
  const host = address.slice(0, separator);
  const port = address.slice(separator + 1);
  if (separator <= 0 || !/^\d+$/.test(port)) {
    throw new Error(
      `container ${containerName} publishes ${AGENT_CONTAINER_PORT} at an address the client cannot read: ${address}`,
    );
  }
  return `http://${LOOPBACK_BY_UNSPECIFIED_HOST[host] ?? host}:${port}/`;
}

/**
 * An agent in a local container, found by name: the port it publishes is
 * resolved on every call, so the transport stays correct after the container
 * restarts on another port.
 */
export function localContainerTransport(containerName: string): Transport {
  return {
    async call(method, params, runtimeSessionId) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync('docker', [
          'port',
          containerName,
          AGENT_CONTAINER_PORT,
        ]));
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        const reason =
          typeof stderr === 'string' && stderr.trim() !== ''
            ? stderr.trim()
            : (error as Error).message;
        throw new Error(
          `cannot resolve container ${containerName}'s ${AGENT_CONTAINER_PORT}: ${reason}`,
          { cause: error },
        );
      }
      return localTransport(publishedUrl(containerName, stdout)).call(
        method,
        params,
        runtimeSessionId,
      );
    },
  };
}
