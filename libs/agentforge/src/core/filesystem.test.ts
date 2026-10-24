import { describe, expect, it } from 'vitest';
import {
  FILESYSTEM_BUCKETS_VARIABLE,
  FILESYSTEM_REPOSITORIES_VARIABLE,
  parseDeclared,
  parseRepositoryRemote,
} from './filesystem.ts';

describe('parseDeclared', () => {
  it('reads a declaration, and none when the variable is unset', () => {
    expect(
      parseDeclared(
        FILESYSTEM_REPOSITORIES_VARIABLE,
        '{"vault":".agentforge/repositories/vault.git"}',
      ),
    ).toEqual({ vault: '.agentforge/repositories/vault.git' });
    expect(parseDeclared(FILESYSTEM_BUCKETS_VARIABLE, undefined)).toEqual({});
  });

  it.each([
    ['not JSON', '{vault', /AGENTFORGE_FILESYSTEM_REPOSITORIES is not JSON/],
    [
      'not a map of names',
      '["vault"]',
      /AGENTFORGE_FILESYSTEM_REPOSITORIES is not a JSON object of names/,
    ],
    [
      'an empty location',
      '{"vault":""}',
      /AGENTFORGE_FILESYSTEM_REPOSITORIES is not a JSON object of names/,
    ],
  ])(
    'refuses a value that is %s, naming the variable',
    (_label, value, message) => {
      expect(() =>
        parseDeclared(FILESYSTEM_REPOSITORIES_VARIABLE, value),
      ).toThrow(message);
    },
  );
});

describe('parseRepositoryRemote', () => {
  it('accepts a remote of an allowed scheme', () => {
    expect(
      parseRepositoryRemote('vault', 'https://github.com/o/vault.git', [
        'https:',
      ]).host,
    ).toBe('github.com');
  });

  it.each([
    ['not a URL', 'github.com/o/vault', /vault is not a URL/],
    [
      'another scheme',
      'ssh://git@github.com/o/vault',
      /must be https:\/\/, not ssh:/,
    ],
    [
      'a user name',
      'https://x-access-token@github.com/o/vault',
      /carries a credential/,
    ],
    [
      'a password',
      'https://x:secret@github.com/o/vault',
      /carries a credential/,
    ],
  ])('refuses %s, never echoing the URL', (_label, location, message) => {
    let error: unknown;
    try {
      parseRepositoryRemote('vault', location, ['https:']);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('secret');
  });
});
