import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The entry-point boundary is enforced, not documented: `/agent` resolves only
 * under the `agentforge-agent` export condition, so a worker's build that
 * imports it fails to resolve rather than bundling the Agent SDK.
 *
 * Resolved against the real `package.json` installed into a scratch consumer,
 * with every export target stubbed. Whether the built files match the map is
 * publint's check, at bundle time.
 */
const packageJsonPath = join(import.meta.dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  name: string;
  exports: Record<string, unknown>;
};
const agentCondition = 'agentforge-agent';
const openEntryPoints = ['contract', 'client', 'temporal', 'infra'];

/** Every file an export target names, however deeply its conditions nest. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(exportTargets);
  }
  throw new Error(`unexpected export target: ${JSON.stringify(value)}`);
}

let consumer: string;

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), 'agentforge-exports-'));
  const installed = join(
    consumer,
    'node_modules',
    ...packageJson.name.split('/'),
  );
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify(packageJson));
  for (const target of exportTargets(packageJson.exports)) {
    const file = join(installed, target);
    if (file.endsWith('package.json')) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export {};\n');
  }
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
});

afterAll(() => {
  rmSync(consumer, { recursive: true, force: true });
});

function nodeImport(specifier: string, conditions: string[]) {
  return spawnSync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(specifier)});`,
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
}

function typescriptResolve(specifier: string, customConditions: string[]) {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    customConditions,
  };
  return ts.resolveModuleName(
    specifier,
    join(consumer, 'index.ts'),
    compilerOptions,
    ts.sys,
  ).resolvedModule;
}

function bunBuild(specifier: string, conditions: string[]) {
  const entry = join(consumer, `import-${conditions.length}.ts`);
  writeFileSync(entry, `export * from ${JSON.stringify(specifier)};\n`);
  return spawnSync(
    'bun',
    [
      'build',
      entry,
      '--target=bun',
      `--outdir=${join(consumer, 'out')}`,
      ...conditions.map((condition) => `--conditions=${condition}`),
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
}

describe('/agent', () => {
  const specifier = `${packageJson.name}/agent`;

  it('does not resolve in Node without the agent condition', () => {
    const result = nodeImport(specifier, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('resolves in Node under the agent condition', () => {
    const result = nodeImport(specifier, [agentCondition]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not resolve for TypeScript without the agent condition', () => {
    expect(typescriptResolve(specifier, [])).toBeUndefined();
  });

  it('resolves for TypeScript under the agent condition, to its declarations', () => {
    expect(
      typescriptResolve(specifier, [agentCondition])?.resolvedFileName,
    ).toMatch(/dist\/agent\.d\.ts$/);
  });

  it('does not bundle with Bun without the agent condition', () => {
    const result = bunBuild(specifier, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Could not resolve: "${specifier}"`);
  });

  it('bundles with Bun under the agent condition', () => {
    const result = bunBuild(specifier, [agentCondition]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe.each(openEntryPoints)('/%s', (entryPoint) => {
  const specifier = `${packageJson.name}/${entryPoint}`;

  it('resolves in Node with no condition', () => {
    const result = nodeImport(specifier, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('resolves for TypeScript with no condition, to its declarations', () => {
    expect(typescriptResolve(specifier, [])?.resolvedFileName).toMatch(
      new RegExp(`dist/${entryPoint}\\.d\\.ts$`),
    );
  });
});

describe('the package root', () => {
  it('exports nothing, so every import names its environment', () => {
    const result = nodeImport(packageJson.name, [agentCondition]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
