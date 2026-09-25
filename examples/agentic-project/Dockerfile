# The agentic base image: FROM AgentForge's base, this project's own
# dependencies and the layer its agents share, all at /agentic — shared
# modules in src/, the house MCP server in mcp/, CLAUDE.md and skills in
# claude/. Each agent's image adds its source at /agentic/agent.
#
# The `manifest` build context is the `manifest` task's output: the
# dependencies AgentForge's base does not already provide, frozen.
FROM agentforge/a2a-claude:local
WORKDIR /agentic
COPY --from=manifest --chown=bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun src src
COPY --chown=bun mcp mcp
COPY --chown=bun claude claude
WORKDIR /agentic/agent
