# Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
# installed version generates. To own it, name it in the project's
# project.json metadata.agentforge.detached.files.
#
# The agentic image: the project's base layer at /workspace/agentic, on the
# AgentForge image. `agentic/$claude/` becomes its `.claude/`, which every
# agent's session composes from its cwd below. The layer's lock is the whole
# workspace's up to it, so the install adds only what this layer adds.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=\$claude agentic/ /workspace/agentic/
COPY --chown=bun agentic/\$claude/ /workspace/agentic/.claude/
COPY --chown=bun agentic/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
