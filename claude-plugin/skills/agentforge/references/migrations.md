# Migrations

How to take a project from one AgentForge to the next. Each entry covers one change set that alters what a consumer wrote or runs. Entries are newest first. Until the package is published, an entry is headed by its AgentForge milestone and date; after that, by version.

To upgrade, apply every entry newer than the AgentForge the project was built against, oldest first. In each entry:

- **Breaks** says what stops compiling, stops working, or changes behaviour.
- **Change** gives the steps, in the order to apply them.
- **Verify** says how to confirm the project is on the new version.

Maintained files are not listed in a Change: `nx sync` rewrites them. Scaffolded files and detached ones are the project's, so their steps are listed. The [ROADMAP](../../../../docs/ROADMAP.md) links each milestone's changes.

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
