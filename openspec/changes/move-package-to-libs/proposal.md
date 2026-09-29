# Proposal

## Why

`nx-plugin-baseline` puts the golden example in `packages/examples/*` beside `@aws/nx-plugin`'s `packages/common/*`, which exist only for the examples. With AgentForge itself at `packages/agentforge`, the solution and what dogfoods it share one folder. Moving the package to `libs/agentforge` separates them: `libs/` is AgentForge, `packages/` is what a consumer's workspace would hold. `packages/` was accepted at A0 only because it is `@aws/nx-plugin`'s default; AgentForge controls its own project's location.

## What Changes

- `packages/agentforge` moves to `libs/agentforge`, keeping its project name `@beruangai/agentforge` and its depth, so every relative path inside it is unchanged.
- Root `workspaces` replace `packages/*`, now empty, with `libs/*`; the workspace references, lint overrides, Docker ignore, worktree symlinks and every document naming the old path follow it. Build output moves with it to `dist/libs/agentforge/`.
- `claudeMdExcludes` keeps `packages/**`: the examples' layer instructions will live there, and an IDE session must not load an agent's `CLAUDE.md`.
- The examples' targets that name the old path are updated so they keep building until `nx-plugin-baseline` detaches them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. A move: no behaviour changes (`skip_specs`).

## Impact

- **Code and config:** `tsconfig.json`, `biome.json`, `.dockerignore`, `.claude/settings.json`, `package.json`, `bun.lock`, the package's `project.json`, `tsdown.config.ts`, `vitest.config.mts`, `tsconfig.lib.json`, `container/base-lock.ts`, two integ fixtures, one source comment, `openspec/config.yaml`, the examples' `project.json`.
- **Docs:** CLAUDE.md, `.claude/rules/testing.md`, ARCHITECTURE, the integ AgentCore README, four research notes. Archived changes and `docs/lineage/` are history and keep the old path.
- **Lands before `nx-plugin-baseline`**, whose artifacts are written against `libs/agentforge`.

## Success criteria

- `git grep packages/agentforge` finds nothing outside archived changes and `docs/lineage/`.
- `nx run-many -t build`, the `integ` `local` configuration, and `hello-agent`'s local e2e pass from the new location.

## Non-goals

- Renaming the package or its project, or changing any entry point.
