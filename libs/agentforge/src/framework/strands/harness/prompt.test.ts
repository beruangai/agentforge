import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CachePointBlock, ImageBlock, TextBlock } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { renderPrompt } from './prompt.ts';

describe('renderPrompt', () => {
  it('renders a string as a text block', async () => {
    expect(await renderPrompt('q', '/')).toEqual([new TextBlock('q')]);
  });

  it('renders a context block as its tagged text, then a cache point for a breakpoint', async () => {
    const blocks = await renderPrompt(
      [{ context: 'rules', tag: 'rules', cache: { ttl: '5m' } }, 'q'],
      '/',
    );
    expect(blocks[0]).toBeInstanceOf(TextBlock);
    expect((blocks[0] as TextBlock).text).toContain('<rules>');
    expect(blocks[1]).toEqual(
      new CachePointBlock({ cacheType: 'default', ttl: '5m' }),
    );
    expect(blocks[2]).toEqual(new TextBlock('q'));
  });

  it("reads a file-backed context block against the run's cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'strands-prompt-'));
    await writeFile(path.join(cwd, 'brief.md'), 'the brief');
    const [block] = await renderPrompt([{ filepath: 'brief.md' }], cwd);
    expect((block as TextBlock).text).toContain('the brief');
  });

  it("passes the SDK's own blocks as they are", async () => {
    const image = new ImageBlock({
      format: 'png',
      source: { bytes: new Uint8Array([1]) },
    });
    expect(await renderPrompt([image], '/')).toEqual([image]);
  });
});
