import { describe, expect, it } from 'vitest';
import { workerBuild } from './executor.ts';

describe('bundle-worker', () => {
  const build = workerBuild(
    { root: 'packages/golden-kata-workflows' },
    '/workspace',
    ['@beruangai/source'],
  );

  it('bundles the worker for Node, every Temporal package external, resolved as the workspace resolves', () => {
    expect(build.args).toEqual([
      'build',
      '/workspace/packages/golden-kata-workflows/worker.ts',
      '--target=node',
      '--format=esm',
      '--external=@temporalio/*',
      '--tsconfig-override=/workspace/packages/golden-kata-workflows/tsconfig.lib.json',
      '--conditions=@beruangai/source',
      '--outfile=/workspace/dist/packages/golden-kata-workflows/bundle/worker.mjs',
    ]);
  });

  it("stages the image's files beside it, as its build context", () => {
    expect(build.directory).toBe(
      '/workspace/dist/packages/golden-kata-workflows/bundle',
    );
    expect(build.staged).toEqual(
      ['Dockerfile', 'package.json', 'bun.lock'].map((file) => ({
        from: `/workspace/packages/golden-kata-workflows/container/${file}`,
        to: `/workspace/dist/packages/golden-kata-workflows/bundle/${file}`,
      })),
    );
  });
});
