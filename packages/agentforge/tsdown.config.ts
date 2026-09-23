import { defineConfig } from 'tsdown';

/**
 * One package, five entry points. Code shared between entry points is split
 * into common chunks rather than duplicated into each, and every dependency
 * stays external — only this repository's own source is bundled.
 */
export default defineConfig({
  entry: {
    contract: 'src/core/contract/index.ts',
    client: 'src/client/index.ts',
    temporal: 'src/client/temporal/index.ts',
    agent: 'src/server/harness/index.ts',
    infra: 'src/infra/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  tsconfig: 'tsconfig.lib.json',
  dts: true,
  sourcemap: true,
  outDir: 'dist',
  clean: true,
  fixedExtension: false,
  publint: true,
});
