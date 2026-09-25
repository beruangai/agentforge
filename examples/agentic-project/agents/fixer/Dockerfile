# The fixer agent's image: FROM the project's agentic base, this agent's member
# at /workspace/agentic/agent — its cwd — and the workspace's lock up to it,
# installed so the layer holds only what the agent adds; `files/$claude/` is
# its `.claude/`, the one place a session reads `settings.json` and hooks from.
FROM agentforge-examples/agentic-project:local
COPY --chown=bun --exclude=bun.lock --exclude=\$claude files/ /workspace/agentic/agent/
COPY --chown=bun files/\$claude/ /workspace/agentic/agent/.claude/
COPY --chown=bun files/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
ENV AGENTFORGE_AGENT_NAME=fixer
CMD ["bun", "--conditions=agentforge-agent", "server.ts"]
