# The AgentForge base image, `agentforge/a2a-claude`: Bun, what the Claude
# Code CLI needs at run time, and AgentForge installed into Bun's global
# directory with the peers its server and harness import. An agent's image is
# built FROM it and adds only its own source and what the base lacks.
#
# The build context is the `tarball` task's output: the packed package, and
# the manifest and lockfile that pin its peers.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
FROM ${BUN_IMAGE}
# The Claude CLI's Bash tool refuses busybox sh; it needs bash, named by SHELL.
RUN apk add --no-cache bash git ca-certificates ripgrep \
 && mkdir -p /agentic/agent /mnt/workspace /home/bun/.bun/install/global \
 && chown -R bun:bun /agentic /mnt/workspace /home/bun/.bun
# The CLI refuses to run tools unattended as root; the image never runs as root.
USER bun
WORKDIR /home/bun/.bun/install/global
COPY --chown=bun package.json bun.lock *.tgz ./
# A global install is not on the resolution path. Linked in as the
# node_modules above the agent at /agentic/agent, it resolves as any
# package does — ESM conditions, one copy shared with AgentForge — and its
# presence keeps Bun from auto-installing an import from npm at run time.
# NODE_PATH does neither: Bun resolves it with CommonJS conditions. An agent's
# own node_modules still resolves first.
RUN bun install --frozen-lockfile --production \
 && ln -s /home/bun/.bun/install/global/node_modules /agentic/node_modules
ENV SHELL=/bin/bash AGENTFORGE_PORT=9000
# The agent's code is /agentic/agent, read-only in intent; what the agent
# edits is /mnt/workspace, its `cwd`.
WORKDIR /agentic/agent
EXPOSE 9000
