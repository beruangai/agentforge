import { addProjectConfiguration, type Tree } from '@nx/devkit';

/**
 * Stands in for `@aws/nx-plugin`'s `sharedConstructsGenerator` in unit
 * tests: its GritQL clones a standard library from GitHub on first use. Lays
 * down what AgentForge renders into — the project, its manifest, and the
 * app's index — once, as the real one does.
 */
export async function sharedConstructsGenerator(tree: Tree): Promise<void> {
  const root = 'packages/common/constructs';
  if (tree.exists(`${root}/project.json`)) return;
  addProjectConfiguration(tree, '@proj/common-constructs', {
    root,
    sourceRoot: `${root}/src`,
    projectType: 'library',
    targets: {},
  });
  tree.write(
    `${root}/package.json`,
    `${JSON.stringify({ name: '@proj/common-constructs', type: 'module' }, null, 2)}\n`,
  );
  tree.write(`${root}/src/app/index.ts`, '');
  tree.write(`${root}/src/index.ts`, "export * from './app/index.js';\n");
}
