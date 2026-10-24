# Migrations

How to take a project from one AgentForge to the next. Each entry covers one change set that alters what a consumer wrote or runs. Entries are newest first. Until the package is published, an entry is headed by its AgentForge milestone and date; after that, by version.

To upgrade, apply every entry newer than the AgentForge the project was built against, oldest first. In each entry:

- **Breaks** says what stops compiling, stops working, or changes behaviour.
- **Change** gives the steps, in the order to apply them.
- **Verify** says how to confirm the project is on the new version.

Maintained files are not listed in a Change: `nx sync` rewrites them. Scaffolded files and detached ones are the project's, so their steps are listed. The [ROADMAP](../../../../docs/ROADMAP.md) links each milestone's changes.

## git-filesystem, 2026-10-24

### Breaks

- **A filesystem keeps its local copy at unmount**, for the next task of the same runtime session in that container. A procedure that relied on each task starting from the store alone now finds the previous task's files there, those outside the write scope included. `ScratchFilesystem` is unchanged: always removed.
- **`dangerouslyEnableDeletes`** adds a `delete` permission per write glob to a mount's `permissions`. Code that matches on `action` without a default case sees a value it did not handle.
- **`nx sync:check`** reports every agentic and workflow project's `project.json` until it gains the `seed-repository` target.

### Change

1. Run `nx sync`.
2. Declare `removeLocalCopy: true` on each `S3Filesystem` whose tasks must start from the store alone, and on one sharing its prefix with writers that delete: a kept copy does not take their deletions, and its push may restore them.
3. A handler that switches over `permissions` handles `delete`.

### Verify

`nx sync:check` passes, `nx run <project>:seed-repository --help` lists its options, and the project's tests pass.

## Layer manifests out of the root workspace, 2026-10-23

### Breaks

- **`nx sync:check`** reports `package.json (workspaces)` in a workspace whose root globs reach a project's layer manifests (`packages/**`, say) without excluding them.

### Change

1. Run `nx sync`. It appends `!<root>/{agents,base}/**` for each agentic project and `!<root>/container` for each workflow project that the root's globs reach. A negation you wrote already, in any form that excludes them, is kept, and nothing is added for it.

### Verify

`nx sync:check` passes, and `bun install` lists no layer manifest as a workspace member.

## strands-framework, 2026-10-23

### Breaks

None.

### Change

Nothing to change. A new agentic project may choose `--framework strands` ([SKILL.md](../SKILL.md#choosing-a-framework)); it needs `ANTHROPIC_API_KEY` in `.env.serve.local` and, deployed, as a Secrets Manager secret mapped in its agent's construct. §REQ705 is replaced by §REQ714: the subscription stays wherever the framework can use it, so while `CLAUDE_CODE_OAUTH_TOKEN` is set a `claude` run's CLI is given neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN`, and a procedure that sets either in its options' `env` is refused `EXECUTION_ERROR`.

### Verify

`nx sync:check` passes on the existing projects.

## Vitest 5 toolchain, 2026-10-23

### Breaks

- **Peer ranges.** AgentForge needs `nx` and `@nx/devkit` `^23.3.0`, `@aws/nx-plugin` `^1.0.15` and `vitest` `^5.0.4`. Its `init` and generators refuse a catalog below them, naming each.

### Change

1. **Migrate Nx.** Run `nx migrate 23.3.0`, then `nx migrate --run-migrations`, and apply its Vitest 5 prompt.
2. **Raise the catalog.** Set `@aws/nx-plugin` to `1.0.15`, and `vitest` and `@vitest/coverage-v8` to the plugin's `vitest`, `5.0.4`. A second vitest copy breaks `rejects.toThrow` in tests built on the plugin's test utility. Then `bun install`.

### Verify

`nx run-many -t test` passes, and `bun pm ls vitest` shows one version.

## framework-seam, 2026-10-22 (from A6)

### Breaks

- **The project record.** Sync refuses an agentic project whose `project.json` `metadata.agentforge` names no `framework`, naming the field.
- **Imports.** `implementAgent`, `runTaskProcess`, `TaskContext`, `runAgent`, `composeOptions`, `distill` and its types, `documentBlock`, and the Claude prompt and run types (`AgentOptions`, `AgentRun`, `AgentRunSpec`, `AgentPrompt`, `PromptContent`, `ContentBlock`, `CommandBlock`, `ContextDocument`) leave `@beruangai/agentforge/agent` for `@beruangai/agentforge/claude/agent`. `readTranscript` leaves `@beruangai/agentforge/client` for `@beruangai/agentforge/claude/client`. A stale import fails to compile.
- **The cache breakpoint.** A context block's `cache` is `true` or `{ ttl: '5m' | '1h' }`; `{ type: 'ephemeral', ttl }` no longer compiles.
- **Filesystem permissions.** `context.filesystems.<name>.permissions` is data, `{ action: 'read' | 'edit', glob }` relative to the mount, not Claude rule strings. `context.agentOptions` is unchanged for `claude`.
- **The run record.** `modelUsage` leaves the top level: `usage` holds the shared token counts, `rawUsage` the SDK's `modelUsage`, and `framework` names the framework. `totalCostUsd` is optional.
- **Images.** The base image is `agentforge/a2a`, with no bash, git or ripgrep, and the `claude` framework's image, `agentforge/a2a-claude`, is built on it. A project builds both through `image-agentforge` and `image-agentforge-claude`.
- **Infrastructure.** `AgentRuntime` takes `requiredSecrets`, the framework's, which the generated construct passes from `@beruangai/agentforge/claude/infra`.

### Change

1. **Record the framework.** Add `"framework": "claude"` to each agentic project's `project.json` `metadata.agentforge`.
2. **Upgrade and sync.** Take the new AgentForge, run `nx sync`, then `lock` for each layer. This rewrites the task and server entries, the constructs, the base Dockerfile and the targets.
3. **Imports.** In each scaffolded or detached module, import the names listed above from `@beruangai/agentforge/claude/agent`, keeping filesystems, `composeContext`, `ContextBlockFunction`, `StopGuard` and `TaskFailure` on `@beruangai/agentforge/agent`. The base layer's `options.ts` imports `AgentOptions` from `@beruangai/agentforge/claude/agent`.
4. **Transcripts.** Import `readTranscript` from `@beruangai/agentforge/claude/client`.
5. **Cache breakpoints.** Replace `cache: { type: 'ephemeral', ttl }` with `cache: { ttl }`.
6. **Permissions and records.** Code that read a mount's `permissions` as rule strings reads `{ action, glob }`. Code that read a run record's `modelUsage` reads `rawUsage`, or `usage` for token counts.
7. **Detached Dockerfiles and infra.** A detached base `Dockerfile` builds on the framework image its `image` target names. A hand-written `AgentRuntime` passes `requiredSecrets: REQUIRED_SECRETS` from `@beruangai/agentforge/claude/infra`.

### Verify

- `nx sync:check` passes.
- The project's `typecheck`, `lint` and `test` pass.
- `e2e` passes locally. After deploying, `e2e-agentcore` passes, and a task's run records name `framework.name` `claude`.

## A6, 2026-10-08 (from A5)

### Breaks

- **Contracts.** A contract holding `z.object` anywhere in an input or output is refused when the procedure module or the client loads, naming each place.
- **Filesystem options.** `S3Filesystem`'s `localPath` option is now `localRoot`. A scope returns `subpath` instead of `remotePath`. A scope's `read` globs are gone, because a mount is readable whole. `context.filesystems.<name>.localPath`, the resolved mount, keeps its name.
- **Task context.** `context.filesystemPermissions` is gone. `context.agentOptions` replaces it, and adds every mount as an additional directory.
- **Infrastructure.** `AgentRuntime` takes `project` and `agentName`. Its `taskTable`, `sessionBucket`, `dashboard`, `removalPolicy` and `sessionRetention` move to the project's `AgenticProjectResources`, one set per project. Tasks and transcripts in the old per-agent table and bucket are not carried over.
- **The wire.** A task carries `image`, and the client refuses a task without it. The server requires `AGENTFORGE_AGENT_IMAGE`.
- **The image is Debian** (glibc), not Alpine. A detached `Dockerfile` that calls `apk` fails to build.
- **Memory** is off unless a run declares `memoryDirectory`.

### Change

1. **Upgrade and sync.** Take the new AgentForge, run `nx sync`, then `lock` for each layer. This rewrites the maintained Dockerfiles, `server.ts`, `task.ts`, the client, the constructs and the targets, including what sets `AGENTFORGE_AGENT_IMAGE`.
2. **Contracts.** In each agent's `contract.ts`, replace every `z.object` with `z.strictObject`, or with `z.looseObject` where undeclared keys must be kept. A run's agent contract, the `output` given to `runAgent`, may stay `z.object`.
3. **Filesystems.** In shared filesystem options, rename `localPath:` to `localRoot:`. In each `scope`, return `{ subpath }` instead of `{ remotePath }`, and remove `read`.
4. **Options.** Replace uses of `context.filesystemPermissions` with `composeOptions(baseOptions(), context.agentOptions, { … })`.
5. **The read fence.** The base layer's `options.ts` is scaffolded, so it is not updated. Add `permissionMode: 'dontAsk'` and `settings: { permissions: { blockReadsOutsideWorkingDirectories: true } }` to adopt the house default. Then move code an agent runs inline (`python -c`, `sh -c`) into a file in its layer, and allow the command that runs that file. See [implementing.md](implementing.md#bash-and-the-read-fence).
6. **Detached Dockerfiles.** Replace `apk add` with `apt-get install`, run as `USER root`, and end on `USER bun`. Install Python packages into a venv on `PATH`. See the [package README](../../../../libs/agentforge/README.md#detaching).
7. **A detached `serve-<agent>` target or a custom launcher** must pass `AGENTFORGE_AGENT_IMAGE`, naming the image the container runs.
8. **The infra stack.** Pass `removalPolicy` and `sessionRetention` to the project construct, not to each agent. Read the table, bucket and dashboard from `<project>.resources` (for example `resources.sessionBucket.bucketName`).
9. **Deploying the change.** Under `RETAIN`, the default, the old per-agent tables and buckets are left behind on update: delete them once nothing needs them. Under `DESTROY`, empty the old session buckets first, because CloudFormation can't delete a non-empty bucket. Deploy the project and its callers together, since the wire changed.
10. **Memory.** A procedure that should remember across tasks declares `memoryDirectory` over a mounted filesystem. See [implementing.md](implementing.md#memory).

### Verify

- `nx sync:check` passes.
- The project's `typecheck`, `lint` and `test` pass. Loading a procedure module or the client no longer refuses a contract.
- `e2e` passes locally. After deploying, `e2e-agentcore` passes, and a task's `image` names the runtime's container URI.
