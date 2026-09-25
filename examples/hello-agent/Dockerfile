# The agent's image: FROM AgentForge's base, this agent's member at
# /workspace/agentic/agent, and the workspace's lock up to it, installed so
# the layer holds only what the agent adds; `files/$claude/` is its `.claude/`,
# the one place a session reads `settings.json` and hooks from. No agentic
# project sits between.
FROM agentforge/a2a-claude:local
COPY --chown=bun --exclude=bun.lock --exclude=\$claude files/ /workspace/agentic/agent/
COPY --chown=bun files/\$claude/ /workspace/agentic/agent/.claude/
COPY --chown=bun files/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
ENV AGENTFORGE_AGENT_NAME=hello-agent
CMD ["bun", "--conditions=agentforge-agent", "server.ts"]
