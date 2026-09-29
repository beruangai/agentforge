import { createTreeUsingTsSolutionSetup } from '@aws/nx-plugin/sdk/utils/test';
import { type Tree, updateJson } from '@nx/devkit';

/**
 * A workspace as `@aws/nx-plugin`'s preset lays one out, with Bun, catalogs,
 * and AgentForge added to its root — as `nx add @beruangai/agentforge` leaves
 * a consumer's.
 */
export function workspaceTree(
  options: { readonly catalogs?: boolean } = {},
): Tree {
  const tree = createTreeUsingTsSolutionSetup();
  tree.delete('pnpm-workspace.yaml');
  tree.write('bun.lock', '{}\n');
  tree.write(
    'aws-nx-plugin.config.mts',
    `import type { AwsNxPluginConfig } from '@aws/nx-plugin';

export default {
  iac: { provider: 'cdk' },
  packageManager: { catalogs: ${options.catalogs ?? true} },
} satisfies AwsNxPluginConfig;
`,
  );
  updateJson(tree, 'package.json', (manifest) => ({
    ...manifest,
    devDependencies: {
      ...manifest.devDependencies,
      '@beruangai/agentforge': '^1.0.0',
    },
  }));
  return tree;
}

/** Every file in the tree under `directory`, by path, for comparing whole trees. */
export function treeFiles(tree: Tree, directory = ''): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string) => {
    if (tree.isFile(path)) {
      files[path] = tree.read(path, 'utf8') ?? '';
      return;
    }
    for (const child of tree.children(path)) {
      if (child === 'node_modules' || child === '.git') continue;
      visit(path === '' ? child : `${path}/${child}`);
    }
  };
  visit(directory);
  return files;
}
