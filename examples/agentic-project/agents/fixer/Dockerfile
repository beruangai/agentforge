# The fixer agent's image: FROM the project's agentic base, which carries
# AgentForge, the project's dependencies and the shared layer at /agentic;
# this adds only the agent's source, at /agentic/agent.
FROM agentforge-examples/agentic-project:local
COPY --chown=bun src src
ENV AGENTFORGE_AGENT_NAME=fixer
CMD ["bun", "--conditions=agentforge-agent", "src/server.ts"]
