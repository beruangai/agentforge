import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentforgeManifest,
  containerInputsOf,
  requireInstalledInside,
} from './container-inputs.ts';

let workspace: string;

/** A published package's container inputs, at `directory`. */
function writePublished(directory: string): void {
  mkdirSync(join(directory, 'container'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@beruangai/agentforge', version: '1.2.3' }),
  );
  writeFileSync(join(directory, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(directory, 'container', 'package.json'), '{}');
  writeFileSync(join(directory, 'container', 'bun.lock'), '{}');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentforge-container-inputs-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('containerInputsOf', () => {
  it('finds an installed package in its own directory', () => {
    const installed = join(workspace, 'node_modules/@beruangai/agentforge');
    writePublished(installed);
    expect(containerInputsOf(installed, false)).toEqual({
      packageDirectory: installed,
      dockerfile: join(installed, 'Dockerfile'),
      containerDirectory: join(installed, 'container'),
      rootManifest: join(installed, 'container/package.json'),
      rootLock: join(installed, 'container/bun.lock'),
      version: '1.2.3',
    });
  });

  it('finds the source package in its bundle output', () => {
    const source = join(workspace, 'libs/agentforge');
    const bundle = join(workspace, 'dist/libs/agentforge/bundle');
    mkdirSync(source, { recursive: true });
    writePublished(bundle);
    expect(containerInputsOf(source, true)).toMatchObject({
      packageDirectory: bundle,
      rootLock: join(bundle, 'container/bun.lock'),
      version: '1.2.3',
    });
  });

  it('throws naming every path it expected, from source', () => {
    const source = join(workspace, 'libs/agentforge');
    mkdirSync(source, { recursive: true });
    const bundle = join(workspace, 'dist/libs/agentforge/bundle');
    expect(() => containerInputsOf(source, true)).toThrow(
      `AgentForge's container inputs are missing: ${[
        join(bundle, 'package.json'),
        join(bundle, 'Dockerfile'),
        join(bundle, 'container/package.json'),
        join(bundle, 'container/bun.lock'),
      ].join(
        ', ',
      )} (running from source, they are @beruangai/agentforge's bundle output)`,
    );
  });

  it('throws naming the lock an installed package lacks', () => {
    writePublished(workspace);
    rmSync(join(workspace, 'container/bun.lock'));
    expect(() => containerInputsOf(workspace, false)).toThrow(
      `AgentForge's container inputs are missing: ${join(workspace, 'container/bun.lock')}`,
    );
  });
});

describe('requireInstalledInside', () => {
  it('accepts a package installed inside the workspace', () => {
    const installed = join(workspace, 'node_modules/@beruangai/agentforge');
    writePublished(installed);
    expect(() => requireInstalledInside(installed, workspace)).not.toThrow();
  });

  it('refuses a package linked in from outside the workspace, naming where it lives and the archive', () => {
    const consumer = join(workspace, 'consumer');
    const bundle = join(workspace, 'agentforge/dist/libs/agentforge/bundle');
    writePublished(bundle);
    mkdirSync(join(consumer, 'node_modules/@beruangai'), { recursive: true });
    const link = join(consumer, 'node_modules/@beruangai/agentforge');
    symlinkSync(bundle, link);
    expect(() => requireInstalledInside(link, consumer)).toThrow(
      /installed as a link to .*agentforge\/dist\/libs\/agentforge\/bundle.*bun add @beruangai\/agentforge@<path to beruangai-agentforge\.tgz>/,
    );
  });
});

describe('agentforgeManifest', () => {
  it('reads AgentForge from source in its own repository, with no workspace check', () => {
    expect(agentforgeManifest().name).toBe('@beruangai/agentforge');
  });
});
