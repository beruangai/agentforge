# Tasks

## 1. Move

- [x] 1.1 `git mv packages/agentforge libs/agentforge`; root `workspaces` replace `packages/*` with `libs/*`; `bun install` refreshes `bun.lock` — verified by `bun install --frozen-lockfile` passing afterwards
- [x] 1.2 Rewrite every absolute reference in code and config (`tsconfig.json`, `biome.json`, `.dockerignore`, `.claude/settings.json` symlinks, the package's `project.json`, `tsdown.config.ts`, `vitest.config.mts`, `tsconfig.lib.json`, `container/base-lock.ts`, the integ fixtures, the source comment, `openspec/config.yaml`, both examples' `project.json`); `nx reset` — verified by `nx show projects` and `nx run-many -t build` passing
- [x] 1.3 Rewrite the documents (CLAUDE.md, `.claude/rules/testing.md`, ARCHITECTURE, the integ AgentCore README, the research notes) — verified by `git grep packages/agentforge` finding nothing outside archived changes and `docs/lineage/`

## 2. Verification

- [x] 2.1 The `integ` `local` configuration and `hello-agent`'s local e2e pass from the new location
