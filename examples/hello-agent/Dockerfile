# The agent's image: FROM AgentForge's base, which already carries AgentForge
# and every package this agent imports, so the image is its source and how to
# start it. An agent needing more installs only that, from its own lockfile.
FROM agentforge/a2a-claude:local
WORKDIR /agentic/agent
COPY --chown=bun src src
ENV AGENTFORGE_AGENT_NAME=hello-agent
CMD ["bun", "--conditions=agentforge-agent", "src/server.ts"]
