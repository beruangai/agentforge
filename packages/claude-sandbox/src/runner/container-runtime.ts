/* eslint-disable @typescript-eslint/no-empty-function */
import Docker from 'dockerode';

const VALID_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateContainerName(name: string): void {
  if (!VALID_CONTAINER_NAME.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

export interface ContainerCreateOptions {
  image: string;
  name: string;
  env: string[];
  binds: string[];
  network?: string;
  extraHosts: string[];
  openStdin: boolean;
}

export interface ContainerExecResult {
  statusCode: number;
  stdout: string;
  stderr: string;
}

export class ContainerRuntime {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  async createContainer(options: ContainerCreateOptions): Promise<string> {
    validateContainerName(options.name);
    const container = await this.docker.createContainer({
      Image: options.image,
      name: options.name,
      Env: options.env,
      OpenStdin: options.openStdin,
      StdinOnce: options.openStdin,
      AttachStdin: options.openStdin,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: options.binds,
        ExtraHosts: options.extraHosts,
        NetworkMode: options.network,
      },
    });
    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.start();
  }

  async attachContainer(
    id: string,
  ): Promise<{ stream: NodeJS.ReadWriteStream }> {
    const container = this.docker.getContainer(id);
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
    return { stream };
  }

  async waitContainer(
    id: string,
    timeout?: number,
  ): Promise<{ StatusCode: number }> {
    const container = this.docker.getContainer(id);

    if (!timeout) {
      return container.wait();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        try {
          await container.kill();
        } catch {
          // Container may have already exited
        }
        reject(new Error(`Container timed out after ${timeout}ms`));
      }, timeout);

      container
        .wait()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.remove({ force });
  }

  async inspectContainer(id: string): Promise<Docker.ContainerInspectInfo> {
    const container = this.docker.getContainer(id);
    return container.inspect();
  }

  async getContainerLogs(
    id: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const container = this.docker.getContainer(id);
    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    // dockerode returns a Buffer with multiplexed stdout/stderr
    // Each frame: [type(1) + padding(3) + size(4)] + payload
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    const buf = Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(logBuffer);

    while (offset < buf.length) {
      if (offset + 8 > buf.length) break;
      const streamType = buf.readUInt8(offset);
      const size = buf.readUInt32BE(offset + 4);
      const payload = buf.subarray(offset + 8, offset + 8 + size);

      if (streamType === 1) {
        stdout.push(payload);
      } else if (streamType === 2) {
        stderr.push(payload);
      }

      offset += 8 + size;
    }

    return {
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    };
  }

  async imageExists(imageName: string): Promise<boolean> {
    try {
      await this.docker.getImage(imageName).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async inspectImage(name: string): Promise<Docker.ImageInspectInfo> {
    return this.docker.getImage(name).inspect();
  }

  async buildImage(
    context: string,
    dockerfile: string,
    tag: string,
    labels?: Record<string, string>,
  ): Promise<void> {
    const buildOpts: Record<string, unknown> = { t: tag, dockerfile };
    if (labels) {
      buildOpts.labels = labels;
    }

    // List all files in the context directory so Docker receives the full build context
    const { readdirSync } = await import('node:fs');
    const contextFiles = readdirSync(context);

    const stream = await this.docker.buildImage(
      {
        context,
        src: contextFiles,
      },
      buildOpts,
    );

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async cleanupOrphans(prefix: string): Promise<void> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { name: [prefix] },
      });
      for (const info of containers) {
        try {
          const container = this.docker.getContainer(info.Id);
          await container.stop({ t: 1 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        } catch {
          // Continue cleaning up remaining containers
        }
      }
    } catch {
      // Docker may not be available
    }
  }
}
