import { describe, expect, it } from 'vitest';
import type { MountedFilesystem } from '../../../server/harness/filesystem/filesystem.ts';
import { toAgentOptions } from './agent-options.ts';

function mounted(
  localPath: string,
  write: readonly string[] = [],
): MountedFilesystem {
  return {
    localPath,
    permissions: [
      { action: 'read', glob: '**' },
      ...write.map((glob) => ({ action: 'edit' as const, glob })),
    ],
    path: (relativePath) => `${localPath}/${relativePath}`,
    writablePath: (relativePath) => `${localPath}/${relativePath}`,
  };
}

describe('toAgentOptions', () => {
  it('renders a mount as an additional directory and its permissions as Claude Code rules', () => {
    expect(
      toAgentOptions({
        vault: mounted('/workspace/vault', ['notes/today.md']),
      }),
    ).toEqual({
      additionalDirectories: ['/workspace/vault'],
      allowedTools: [
        'Read(//workspace/vault/**)',
        'Edit(//workspace/vault/notes/today.md)',
      ],
    });
  });

  it('renders every mount, in order, without a rule twice', () => {
    expect(
      toAgentOptions({
        vault: mounted('/workspace/vault', ['**']),
        notes: mounted('/workspace/notes', ['**', '**']),
      }),
    ).toEqual({
      additionalDirectories: ['/workspace/vault', '/workspace/notes'],
      allowedTools: [
        'Read(//workspace/vault/**)',
        'Edit(//workspace/vault/**)',
        'Read(//workspace/notes/**)',
        'Edit(//workspace/notes/**)',
      ],
    });
  });

  it('is empty without mounts', () => {
    expect(toAgentOptions({})).toEqual({});
  });
});
