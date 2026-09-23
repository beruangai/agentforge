/**
 * The external base the image tree is built `FROM`, pinned by digest.
 *
 * A constant rather than the digest the tag resolves to at test time, which is
 * what the spike's `setup.sh` did. Resolving the tag would still pin every
 * build within one run, but the input would move whenever `oven/bun` republishes
 * `1.4.0-alpine`, so no two runs would measure the same tree — and the practice
 * being modelled is a digest written down in the build, not one looked up by
 * it. The test asserts the constant still resolves, byte for byte, so a pin the
 * registry stops serving fails as that rather than as a build error.
 *
 * The tag is kept for the reader; with both present, the digest is what every
 * consumer resolves. It is the OCI index, so `linux/arm64` is chosen from it.
 */
export const pinnedBunBaseImage = {
  repository: 'docker.io/oven/bun',
  tag: '1.4.0-alpine',
  indexDigest:
    'sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb',
} as const;

export const pinnedBunBaseImageReference = `${pinnedBunBaseImage.repository}:${pinnedBunBaseImage.tag}@${pinnedBunBaseImage.indexDigest}`;
