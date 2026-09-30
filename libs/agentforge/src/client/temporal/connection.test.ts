import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { describe, expect, it } from 'vitest';
import { agentsFromEnvironment, temporalConnectConfig } from './connection.ts';

const CLOUD = {
  TEMPORAL_ADDRESS: 'namespace.account.tmprl.cloud:7233',
  TEMPORAL_NAMESPACE: 'namespace.account',
};

describe('temporalConnectConfig', () => {
  it('connects to a local server without TLS', () => {
    expect(
      temporalConnectConfig({
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_NAMESPACE: 'default',
      }),
    ).toEqual({
      namespace: 'default',
      connectionOptions: expect.objectContaining({
        address: 'localhost:7233',
        apiKey: undefined,
        tls: undefined,
      }),
    });
  });

  it('connects to Temporal Cloud over TLS with the key', () => {
    expect(
      temporalConnectConfig({ ...CLOUD, TEMPORAL_API_KEY: 'key' }),
    ).toEqual({
      namespace: 'namespace.account',
      connectionOptions: expect.objectContaining({
        address: 'namespace.account.tmprl.cloud:7233',
        apiKey: 'key',
        tls: true,
      }),
    });
  });

  it('refuses an unset address and namespace, naming each', () => {
    expect(() => temporalConnectConfig({})).toThrow(
      'TEMPORAL_ADDRESS is unset; TEMPORAL_NAMESPACE is unset',
    );
    expect(() =>
      temporalConnectConfig({ TEMPORAL_NAMESPACE: 'default' }),
    ).toThrow(/TEMPORAL_ADDRESS is unset$/);
    expect(() =>
      temporalConnectConfig({ TEMPORAL_ADDRESS: CLOUD.TEMPORAL_ADDRESS }),
    ).toThrow(/TEMPORAL_NAMESPACE is unset$/);
  });

  it.each([
    'localhost:7233',
    '127.0.0.1:7233',
    '[::1]:7233',
    'host.docker.internal:7233',
  ])('refuses a key with the local address %s', (address) => {
    expect(() =>
      temporalConnectConfig({
        TEMPORAL_ADDRESS: address,
        TEMPORAL_NAMESPACE: 'default',
        TEMPORAL_API_KEY: 'key',
      }),
    ).toThrow(`TEMPORAL_API_KEY is set with the local address ${address}`);
  });

  it('reads no profile file from the default location', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'agentforge-envconfig-'));
    const profile = '[profile.default]\naddress = "from-file:7233"\n';
    for (const directory of [
      path.join(home, 'Library', 'Application Support', 'temporalio'),
      path.join(home, '.config', 'temporalio'),
    ]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'temporal.toml'), profile);
    }
    const environment = { HOME: home, TEMPORAL_NAMESPACE: 'default' };
    // Without `disableFile`, envconfig would read it.
    expect(
      loadClientConnectConfig({ overrideEnvVars: environment })
        .connectionOptions.address,
    ).toBe('from-file:7233');
    expect(() => temporalConnectConfig(environment)).toThrow(
      /TEMPORAL_ADDRESS is unset/,
    );
  });
});

describe('agentsFromEnvironment', () => {
  it('reads local agents', () => {
    expect(agentsFromEnvironment({ AGENTFORGE_AGENTS: 'local' })).toEqual({
      kind: 'local',
    });
  });

  it("reads the deployment's runtime configuration", () => {
    expect(
      agentsFromEnvironment({ AGENTFORGE_AGENTS: 'runtime-config:abc123' }),
    ).toEqual({ kind: 'runtime-config', applicationId: 'abc123' });
  });

  it.each([
    [{}, 'AGENTFORGE_AGENTS is unset'],
    [{ AGENTFORGE_AGENTS: 'runtime-config:' }, "'runtime-config:'"],
    [{ AGENTFORGE_AGENTS: 'cloud' }, "'cloud'"],
  ])('refuses %o, naming the setting', (environment, message) => {
    expect(() => agentsFromEnvironment(environment)).toThrow(message);
  });
});
