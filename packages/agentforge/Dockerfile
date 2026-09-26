# The AgentForge base image, `agentforge/a2a-claude`: Bun, what the Claude
# Code CLI needs at run time, the ADOT collector that carries the CLI's
# telemetry to CloudWatch, and the container's `/workspace` — a Bun
# workspace whose root depends on the peers AgentForge's server and harness
# import, with AgentForge itself as the member at `/workspace/agentforge`.
#
# An agentic project's image adds its member at `/workspace/agentic`, and an
# agent's image its member at `/workspace/agentic/agent`; each copies in its
# own lock of the whole workspace and installs, so a layer bakes in only what
# it adds and every layer resolves shared packages to one copy.
#
# Build context: the published bundle, which becomes the `agentforge` member.
# The `container` context holds the root manifest and its lock.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
ARG COLLECTOR_IMAGE=public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0@sha256:7968fb60db6a2390a47ba6a2df029745638486e285c9b2487da1b722d0855a3e
FROM ${COLLECTOR_IMAGE} AS collector
FROM ${BUN_IMAGE}
# A static binary; the server starts it when the construct sets a telemetry level.
COPY --from=collector /awscollector /usr/local/bin/aws-otel-collector
# The Claude CLI's Bash tool refuses busybox sh; it needs bash, named by SHELL.
RUN apk add --no-cache bash git ca-certificates ripgrep \
 && mkdir -p /workspace/agentforge /workspace/agentic/agent \
 && chown -R bun:bun /workspace
# The CLI refuses to run tools unattended as root; the image never runs as root.
USER bun
WORKDIR /workspace
COPY --from=container --chown=bun package.json bun.lock ./
COPY --chown=bun . agentforge/
RUN bun install --frozen-lockfile --production
# Each run's cwd: the agent's own directory, so every layer's `.claude/`
# composes up the tree from it.
WORKDIR /workspace/agentic/agent
ENV SHELL=/bin/bash AGENTFORGE_PORT=9000
EXPOSE 9000
