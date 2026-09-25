# The agent's image: FROM AgentForge's base, dependencies installed from the
# workspace lockfile — nothing is bundled — and the agent's source run by Bun.
# Built from the workspace root (see project.json's `image` target).
FROM agentforge/a2a-claude:local
WORKDIR /home/bun/app
COPY --chown=bun package.json bun.lock ./
COPY --chown=bun packages/agentforge/package.json packages/agentforge/
COPY --chown=bun examples/hello-agent/package.json examples/hello-agent/
RUN bun install --frozen-lockfile --production --linker hoisted --filter @beruangai/example-hello-agent
# The published package in place of the workspace link: what a consumer gets.
COPY --chown=bun dist/packages/agentforge/bundle/ packages/agentforge/
COPY --chown=bun examples/hello-agent/src examples/hello-agent/src
WORKDIR /home/bun/app/examples/hello-agent
ENV AGENTFORGE_AGENT_NAME=hello-agent
CMD ["bun", "--conditions=agentforge-agent", "src/server.ts"]
