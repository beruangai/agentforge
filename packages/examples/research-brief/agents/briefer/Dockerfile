# check=skip=InvalidDefaultArgInFrom
# Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
# installed version generates. To own it, name it in the project's
# project.json metadata.agentforge.detached.files.
#
# The briefer agent's image: its layer at /workspace/agentic/agent — every
# run's cwd — on the project's agentic image. `agent/.agent/` becomes its
# `.agent/`, whose skills this agent loads beside the base layer's.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=.agent agent/ /workspace/agentic/agent/
COPY --chown=bun agent/.agent/ /workspace/agentic/agent/.agent/
COPY --chown=bun agent/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
ENV AGENTFORGE_AGENT_NAME=briefer
CMD ["bun", "--conditions=agentforge-agent", "server.ts"]
