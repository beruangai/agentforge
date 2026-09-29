import type { Tree } from '@nx/devkit';

export default async function initGenerator(tree: Tree): Promise<void> {
  tree.write('agentforge-placeholder.txt', 'init ran\n');
}
