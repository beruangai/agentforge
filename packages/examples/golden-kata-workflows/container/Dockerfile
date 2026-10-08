# Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
# installed version generates. To own it, name it in the project's
# project.json metadata.agentforge.detached.files.
#
# The worker's image. Its build context is the project's `bundle` output:
# worker.mjs, workflows.js, and this directory's package.json and bun.lock.
# Bun installs the Temporal packages the bundle leaves external; Node runs it.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
ARG NODE_IMAGE=docker.io/library/node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /worker
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM ${NODE_IMAGE}
# The SDK's core verifies Temporal Cloud's TLS against the system store,
# which the slim image lacks; Node's bundled roots do not reach it.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY --from=dependencies /worker/node_modules ./node_modules
COPY package.json worker.mjs workflows.js ./
USER node
CMD ["node", "worker.mjs"]
