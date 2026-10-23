# check=skip=InvalidDefaultArgInFrom
# Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
# installed version generates. To own it, name it in the project's
# project.json metadata.agentforge.detached.files.
#
# The agentic image: the project's base layer at /workspace/agentic, on the
# strands framework's AgentForge image. `agentic/.agent/` becomes its
# `.agent/`, whose skills every agent below loads. The
# layer's lock is the whole workspace's up to it, so the install adds only
# what this layer adds.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=.agent agentic/ /workspace/agentic/
COPY --chown=bun agentic/.agent/ /workspace/agentic/.agent/
COPY --chown=bun agentic/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
