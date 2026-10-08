import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerInputsOf } from './container-inputs.ts';

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
