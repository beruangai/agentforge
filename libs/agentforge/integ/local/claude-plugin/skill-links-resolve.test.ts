/**
 * Every relative link in the plugin's skill and its references resolves to a
 * file in the repository (§REQ712). The plugin loads in place from a
 * developer's clone, so the skill links the repository's own docs rather than
 * restating them; a link a rename breaks fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_DIRECTORY,
  REPOSITORY_ROOT,
} from './__fixtures__/repository.ts';

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const NOT_A_FILE_LINK = /^(https?:|mailto:|#)/;

function markdownFiles(): string[] {
  return readdirSync(PLUGIN_DIRECTORY, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.md'))
    .map((path) => join(PLUGIN_DIRECTORY, path));
}

describe("the agentforge skill's links", () => {
  it('resolve to files in the repository', () => {
    const files = markdownFiles();
    expect(files).toContain(
      join(PLUGIN_DIRECTORY, 'skills/agentforge/SKILL.md'),
    );

    const unresolved: string[] = [];
    for (const file of files) {
      for (const [, target] of readFileSync(file, 'utf8').matchAll(
        MARKDOWN_LINK,
      )) {
        if (target === undefined || NOT_A_FILE_LINK.test(target)) continue;
        const path = resolve(
          dirname(file),
          decodeURI(target.split('#')[0] ?? ''),
        );
        const insideRepository = !relative(REPOSITORY_ROOT, path).startsWith(
          '..',
        );
        if (!insideRepository || !existsSync(path)) {
          unresolved.push(`${relative(REPOSITORY_ROOT, file)} → ${target}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
