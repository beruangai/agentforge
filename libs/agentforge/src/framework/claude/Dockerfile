# The claude framework's AgentForge image, `agentforge/a2a-claude`, on the base
# `agentforge/a2a`: what the Claude Code CLI needs at run time, and the
# container workspace's root extended with the Agent SDK and the Anthropic
# SDK, which bring the CLI's binary. The framework is not a member: its root
# manifest is the base's plus its peers, with the same member globs, so the
# bundle's `framework/claude` code at `/workspace/agentforge` resolves the SDKs
# from the root's `node_modules`.
#
# Build context, and the `container` context: this framework's root manifest
# and its lock, which `container-lock-claude` writes seeded with the base's.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
# The Claude CLI's Bash tool needs bash, named by SHELL; git and ripgrep are its tools'.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends bash git ripgrep \
 && rm -rf /var/lib/apt/lists/*
# The CLI refuses to run tools unattended as root; the image never runs as root.
USER bun
WORKDIR /workspace
COPY --from=container --chown=bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# Each run's cwd: the agent's own directory, so every layer's `.claude/`
# composes up the tree from it.
WORKDIR /workspace/agentic/agent
ENV SHELL=/bin/bash
