import { describe, expect, it } from 'vitest';
import { subscriptionEnv } from './credentials.ts';

const OAUTH = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' };
const OUTRANKING = { ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'bearer' };

describe('the CLI’s credentials', () => {
  it('leaves out an inherited credential that outranks the OAuth token', () => {
    expect(subscriptionEnv({ ...OAUTH, ...OUTRANKING, PATH: '/bin' })).toEqual({
      ...OAUTH,
      PATH: '/bin',
    });
  });

  it('keeps every variable without the OAuth token', () => {
    expect(subscriptionEnv(OUTRANKING)).toEqual(OUTRANKING);
  });

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])(
    'refuses %s set by the procedure beside the OAuth token',
    (variable) => {
      expect(() => subscriptionEnv(OAUTH, { [variable]: 'own' })).toThrow(
        `the run sets ${variable} in its env`,
      );
    },
  );

  it('takes the OAuth token from the procedure’s env too', () => {
    expect(subscriptionEnv(OUTRANKING, OAUTH)).toEqual(OAUTH);
  });
});
