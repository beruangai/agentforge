import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The base image's `Dockerfile`, which pins the Bun image it is built on. */
const BASE_DOCKERFILE = join(import.meta.dirname, '..', '..', 'Dockerfile');
const BUN_IMAGE_ARGUMENT = /^ARG BUN_IMAGE=(\S+)$/m;

/**
 * The external base the integration images are built `FROM`: the Bun image
 * the base image's `Dockerfile` pins by digest, read from it, so a bump there
 * moves the integration images with it. It is the OCI index, so
 * `linux/arm64` is chosen from it. A pin the registry stops serving fails as a
 * build error.
 */
export async function readPinnedBunBaseImage(): Promise<string> {
  const reference = BUN_IMAGE_ARGUMENT.exec(
    await readFile(BASE_DOCKERFILE, 'utf8'),
  )?.[1];
  if (reference === undefined) {
    throw new Error(`${BASE_DOCKERFILE} declares no ARG BUN_IMAGE=<image>`);
  }
  if (!reference.includes('@sha256:')) {
    throw new Error(
      `${BASE_DOCKERFILE} pins BUN_IMAGE by tag alone, not by digest: ${reference}`,
    );
  }
  return reference;
}
