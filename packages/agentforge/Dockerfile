# The AgentForge base image, `agentforge/a2a-claude`: Bun and what the Claude
# Code CLI needs at run time, and nothing else. An agent's own image is built
# FROM it and installs its dependencies from its own lockfile.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
FROM ${BUN_IMAGE}
# The Claude CLI's Bash tool refuses busybox sh; it needs bash, named by SHELL.
RUN apk add --no-cache bash git ca-certificates ripgrep \
 && mkdir -p /home/bun/app /home/bun/work \
 && chown bun:bun /home/bun/app /home/bun/work
# The CLI refuses to run tools unattended as root; the image never runs as root.
USER bun
WORKDIR /home/bun/app
ENV SHELL=/bin/bash AGENTFORGE_PORT=9000
EXPOSE 9000
