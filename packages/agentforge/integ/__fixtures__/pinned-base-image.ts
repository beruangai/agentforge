/**
 * The external base the integration images are built `FROM`, pinned by digest.
 *
 * A constant rather than the digest the tag resolves to at test time: the input
 * would otherwise move whenever `oven/bun` republishes `1.4.0-alpine`, and the
 * practice being modelled is a digest written down in the build, not one
 * looked up by it. A pin the registry stops serving fails as a build error.
 *
 * The tag is kept for the reader; with both present, the digest is what every
 * consumer resolves. It is the OCI index, so `linux/arm64` is chosen from it.
 */
export const PINNED_BUN_BASE_IMAGE = {
  repository: 'docker.io/oven/bun',
  tag: '1.4.0-alpine',
  indexDigest:
    'sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb',
} as const;

export const PINNED_BUN_BASE_IMAGE_REFERENCE = `${PINNED_BUN_BASE_IMAGE.repository}:${PINNED_BUN_BASE_IMAGE.tag}@${PINNED_BUN_BASE_IMAGE.indexDigest}`;
