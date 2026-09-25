# The agentic base image: FROM AgentForge's base, the project's member at
# /workspace/agentic — the modules and house MCP server its agents share —
# with `files/$claude/` as its `.claude/`, which every agent's session
# composes from its cwd below. `$claude/` sits inside `files/` so a path
# between it and the member's other files is the same in the repo and the
# image. The member's lock is the whole workspace's up to this layer, so the
# install bakes in only what the project adds.
FROM agentforge/a2a-claude:local
COPY --chown=bun --exclude=bun.lock --exclude=\$claude files/ /workspace/agentic/
COPY --chown=bun files/\$claude/ /workspace/agentic/.claude/
COPY --chown=bun files/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
