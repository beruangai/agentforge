import { describe, expect, it, vi } from 'vitest';

import { resolveCredentialEnv } from './credential-config.js';

describe('resolveCredentialEnv', () => {
  it('returns empty object for undefined config', () => {
    expect(resolveCredentialEnv(undefined)).toEqual({});
  });

  it('returns empty object for env mode (pass-through)', () => {
    expect(resolveCredentialEnv({ mode: 'env' })).toEqual({});
  });

  it('warns when env mode is used without any credentials', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveCredentialEnv({ mode: 'env' }, { OTHER_VAR: 'value' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN',
      ),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when env mode has ANTHROPIC_API_KEY', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveCredentialEnv({ mode: 'env' }, { ANTHROPIC_API_KEY: 'sk-test' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when env mode has CLAUDE_CODE_OAUTH_TOKEN', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveCredentialEnv(
      { mode: 'env' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123' },
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when env mode has no execEnv (validation skipped)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveCredentialEnv({ mode: 'env' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('generates onecli env vars with proxy URL', () => {
    const result = resolveCredentialEnv({
      mode: 'onecli',
      proxyUrl: 'https://proxy.internal:8443',
    });

    expect(result).toEqual({
      ANTHROPIC_AUTH_MODE: 'onecli',
      ANTHROPIC_PROXY_URL: 'https://proxy.internal:8443',
    });
  });

  it('includes agent ID for onecli mode when provided', () => {
    const result = resolveCredentialEnv({
      mode: 'onecli',
      proxyUrl: 'https://proxy.internal:8443',
      agent: 'research-agent',
    });

    expect(result).toEqual({
      ANTHROPIC_AUTH_MODE: 'onecli',
      ANTHROPIC_PROXY_URL: 'https://proxy.internal:8443',
      ANTHROPIC_AGENT_ID: 'research-agent',
    });
  });

  it('throws if onecli mode has no proxy URL', () => {
    expect(() => resolveCredentialEnv({ mode: 'onecli' })).toThrow(
      'onecli mode requires proxyUrl',
    );
  });

  it('generates proxy env vars with default URL', () => {
    const result = resolveCredentialEnv({ mode: 'proxy' });

    expect(result).toEqual({
      ANTHROPIC_AUTH_MODE: 'proxy',
      ANTHROPIC_CREDENTIAL_PROXY_URL: 'http://host.docker.internal:3128',
    });
  });

  it('generates proxy env vars with custom URL', () => {
    const result = resolveCredentialEnv({
      mode: 'proxy',
      credentialProxyUrl: 'http://localhost:9999',
    });

    expect(result).toEqual({
      ANTHROPIC_AUTH_MODE: 'proxy',
      ANTHROPIC_CREDENTIAL_PROXY_URL: 'http://localhost:9999',
    });
  });

  it('includes agent ID for proxy mode when provided', () => {
    const result = resolveCredentialEnv({
      mode: 'proxy',
      agent: 'task-agent',
    });

    expect(result).toEqual({
      ANTHROPIC_AUTH_MODE: 'proxy',
      ANTHROPIC_CREDENTIAL_PROXY_URL: 'http://host.docker.internal:3128',
      ANTHROPIC_AGENT_ID: 'task-agent',
    });
  });
});
