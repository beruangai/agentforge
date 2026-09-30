# Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
# installed version generates. To own it, name it in the project's
# project.json metadata.agentforge.detached.files.
#
# The grader agent's image: its layer at /workspace/agentic/agent — every
# run's cwd — on the project's agentic image. `agent/$claude/` becomes its
# `.claude/`, the one place a session reads `settings.json` and hooks from.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=\$claude agent/ /workspace/agentic/agent/
COPY --chown=bun agent/\$claude/ /workspace/agentic/agent/.claude/
COPY --chown=bun agent/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
ENV AGENTFORGE_AGENT_NAME=grader
CMD ["bun", "--conditions=agentforge-agent", "server.ts"]
