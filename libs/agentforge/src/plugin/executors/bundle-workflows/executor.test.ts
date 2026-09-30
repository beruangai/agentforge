import { describe, expect, it } from 'vitest';
import { workflowBundleFile, workflowBundleOptions } from './executor.ts';

const PROJECT = { root: 'packages/golden-kata-workflows' };

describe('bundle-workflows', () => {
  it("bundles the project's workflow entry beside the worker bundle", () => {
    expect(workflowBundleOptions(PROJECT, '/workspace', []).workflowsPath).toBe(
      '/workspace/packages/golden-kata-workflows/workflows/index.ts',
    );
    expect(workflowBundleFile(PROJECT, '/workspace')).toBe(
      '/workspace/dist/packages/golden-kata-workflows/bundle/workflows.js',
    );
  });

  it("resolves with the workspace's conditions ahead of webpack's own", () => {
    const { webpackConfigHook } = workflowBundleOptions(PROJECT, '/workspace', [
      '@beruangai/source',
    ]);
    expect(
      webpackConfigHook?.({ resolve: { extensions: ['.ts', '.js'] } }),
    ).toEqual({
      resolve: {
        extensions: ['.ts', '.js'],
        conditionNames: ['@beruangai/source', '...'],
      },
    });
  });
});
