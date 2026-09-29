# Design

Guidance, not prescription: adapt to actual constraints.

## Context

See proposal.md for why. `packages/agentforge` sits two levels below the root, and everything inside it reaches the root as `../../`, so a move to `libs/agentforge` keeps every relative path. What names the old location absolutely is listed in the proposal's Impact, found by `git grep packages/agentforge`.

## Decisions

- **`git mv`, then rewrite every absolute reference.** History follows the file; nothing is copied.
- **Output follows the project.** `dist/{projectRoot}/<task>/` becomes `dist/libs/agentforge/<task>/` with no rule changed; the literal paths in `tsdown.config.ts`, `base-lock.ts`, the integ fixtures and the examples' targets are rewritten.
- **The project name stays `@beruangai/agentforge`.** Targets are addressed by name, so no `dependsOn` changes.
- **`claudeMdExcludes` keeps `packages/**`.** It no longer excludes the package, which has no `CLAUDE.md`; it will exclude the examples' layer instructions, which must not load into an IDE session.
- **History keeps the old path.** Archived changes and `docs/lineage/` record what was, and are not rewritten.

## Risks / Trade-offs

- [Nx's cached project graph and outputs name the old root] → `nx reset` once after the move.
- [A worktree's symlinked `node_modules` points at the old path] → the settings' symlink list is updated; existing worktrees are recreated.

## Migration Plan

One commit: the move, the rewrites, `bun install` to refresh `bun.lock`, `nx reset`, then the verification in tasks.md. Rollback is reverting it.
