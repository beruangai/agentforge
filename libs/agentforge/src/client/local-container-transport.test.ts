import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { localContainerTransport } from './local-container-transport.ts';

/** An agent on 127.0.0.1 that answers every call with its own name. */
async function startAgent(
  name: string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const { id } = JSON.parse(body) as { id: string };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { name } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

let first: { server: Server; port: number };
let second: { server: Server; port: number };
let scripts: string;
const PATH = process.env.PATH;

/** A `docker` on PATH that runs `body` as its script. */
function scriptDocker(body: string): void {
  const docker = join(scripts, 'docker');
  writeFileSync(docker, `#!/bin/sh\n${body}\n`);
  chmodSync(docker, 0o755);
  process.env.PATH = `${scripts}:${PATH}`;
}

beforeAll(async () => {
  first = await startAgent('first');
  second = await startAgent('second');
});
afterAll(async () => {
  await Promise.all(
    [first, second].map(
      ({ server }) => new Promise((resolve) => server.close(resolve)),
    ),
  );
});

describe('localContainerTransport', () => {
  beforeEach(() => {
    scripts = mkdtempSync(join(tmpdir(), 'agentforge-docker-'));
  });
  afterEach(() => {
    process.env.PATH = PATH;
    rmSync(scripts, { recursive: true, force: true });
  });

  it('reaches the port the container publishes, resolved again on each call', async () => {
    const transport = localContainerTransport('hello-agent');
    scriptDocker(
      `[ "$*" = "port hello-agent 9000/tcp" ] || exit 2\nprintf '0.0.0.0:${first.port}\\n[::]:${first.port}\\n'`,
    );
    await expect(transport.call('GetTask', {}, 'session')).resolves.toEqual({
      name: 'first',
    });
    scriptDocker(`printf '127.0.0.1:${second.port}\\n'`);
    await expect(transport.call('GetTask', {}, 'session')).resolves.toEqual({
      name: 'second',
    });
  });

  it('throws naming a container that is not running', async () => {
    scriptDocker(
      `echo "Error response from daemon: No such container: hello-agent" >&2\nexit 1`,
    );
    await expect(
      localContainerTransport('hello-agent').call('GetTask', {}, 'session'),
    ).rejects.toThrow(/hello-agent.*9000\/tcp.*No such container: hello-agent/);
  });

  it('throws naming a container that publishes no 9000', async () => {
    scriptDocker('exit 0');
    await expect(
      localContainerTransport('hello-agent').call('GetTask', {}, 'session'),
    ).rejects.toThrow('container hello-agent publishes no port for 9000/tcp');
  });

  it('throws naming the container when docker is not on PATH', async () => {
    process.env.PATH = scripts;
    const failed = await localContainerTransport('hello-agent')
      .call('GetTask', {}, 'session')
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch(/hello-agent/);
    expect((failed as Error).cause).toMatchObject({ code: 'ENOENT' });
  });
});
