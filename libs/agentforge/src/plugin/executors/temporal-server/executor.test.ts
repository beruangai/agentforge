import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { temporalServerCommands } from './executor.ts';

const composeFileOf = (args: readonly string[]): string => {
  const file = args[args.indexOf('--file') + 1];
  if (file === undefined) throw new Error('no --file');
  return file;
};

describe('temporal-server', () => {
  it('starts the shared server, then registers the namespace', () => {
    const commands = temporalServerCommands(
      {},
      { TEMPORAL_NAMESPACE: 'acme.local' },
    );
    expect(commands.map((args) => args.slice(5))).toEqual([
      ['up', '--detach', '--wait'],
      ['run', '--rm', 'temporal-create-namespace'],
    ]);
    for (const args of commands) {
      expect(args.slice(0, 3)).toEqual([
        'compose',
        '--project-name',
        'agentforge-temporal',
      ]);
      expect(existsSync(composeFileOf(args))).toBe(true);
    }
  });

  it('refuses to start without a namespace', () => {
    expect(() => temporalServerCommands({}, {})).toThrow(
      /TEMPORAL_NAMESPACE is not set/,
    );
  });

  it('stops the server without one', () => {
    expect(
      temporalServerCommands({ stop: true }, {}).map((args) => args.slice(5)),
    ).toEqual([['down']]);
  });
});
