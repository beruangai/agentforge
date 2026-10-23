# The strands framework's AgentForge image, `agentforge/a2a-strands`, on the
# base `agentforge/a2a`: the container workspace's root extended with the
# Strands Agents SDK and the peers its runner uses. No Claude binary: the
# runner calls the Anthropic API in-process, and the vended shell runs
# `sh -c`, which the base has. The framework is not a member: its root
# manifest is the base's plus its peers, with the same member globs, so the
# bundle's `framework/strands` code at `/workspace/agentforge` resolves the
# SDK from the root's `node_modules`.
#
# Build context, and the `container` context: this framework's root manifest
# and its lock, which `container-lock-strands` writes seeded with the base's.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /workspace
COPY --from=container --chown=bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# Each run's cwd: the agent's own directory, below the base layer, the two
# layers whose `AGENTS.md` and `.agent/skills/` compose into every run.
WORKDIR /workspace/agentic/agent
