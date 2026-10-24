## Why

StrategyFoundry needs durable storage for its core strategy artifacts, with history. S3 Files, a mounted S3 filesystem, needs VPC network mode, which AgentForge tabled as a default (`docs/DESIGN_OPTIONS.md`, Tabled: Mounts; [ADR 0011](../../../adr/0011-state-persists-through-apis-not-mounts.md)). StrategyFoundry will instead adopt the git-based storage TrendBot runs on today, and the operator wants it built into AgentForge as a `Filesystem` kind with the S3 filesystem's semantics. [ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md) already anticipates it: "A consumer subclasses for its own kind; git comes later."

TrendBot's git lifecycle (`trendbot-monorepo/packages/agentforge/src/runtime/agentcore/trpc/middleware/git-lifecycle.ts`) is evidence, not a specification (`docs/lineage/predecessor-harness.md`). Its lifecycle mostly fits AgentForge's. Where it does not, the cause is its own: requests queued behind a mutex, a commit with no write scope, and process-wide auth set on `process.env`.

Reviewing it also showed that AgentForge's own unmount is too aggressive for every kind. Removing the local copy after every task re-pulls the same mount for every task in a runtime session: network traffic and latency, and for S3, reads paid per task. The runtime session already isolates the container, so the removal buys little (operator, 2026-10-24).

## What Changes

### The base lifecycle, for every kind

- **Unmount keeps the local copy by default.** Removing it becomes opt-in, per filesystem. The claim on the directory is still released at unmount. A later task in the same container that mounts the same directory reuses the copy, and its pull brings it up to date incrementally. `ScratchFilesystem` still removes its directory: its subpath is the task's id, so its copy is never reused.
- **Deletes are a permission when enabled.** With deletes enabled, a mount's baseline permissions include `delete` on each write glob, and each framework renders that in its own terms. Off by default, as today.

### `GitFilesystem`, a third built-in kind

It sits beside `S3Filesystem` and `ScratchFilesystem`, is exported from `/agent`, and implements `pull` and `push`.

- **Store.** One branch of one repository. `remoteRoot` and `subpath` are a path in that branch's tree. `branch` is an option, `main` by default, with no branching per task, procedure or agent.
- **Repository.** Named in options, like `bucket`. The deployment maps the name to a URL through env files with Nx's semantics: `.env` holds the default remote, and `.env.serve.local` a local repository path, which the serve target bind-mounts.
- **pull.** First mount in a container: a private partial clone of the branch, outside the mount, with the tree at `<remotePath>` materialized as the mount's root. Later mounts fetch and rebase the kept copy.
- **push.** Changed files in the write scope (by the globs `writablePath` matches) are committed onto the pulled base, rebased onto the remote tip, and pushed, with a bounded fetch–rebase–push retry. A push with no changes is a no-op.
- **No checkpoints.** The kind refuses the `checkpoints` option.
- **Deletes.** `dangerouslyEnableDeletes`, off by default. A delete is relative to the pulled base.
- **Credentials.** The token is held in Secrets Manager and rotated manually for now. It is given to git through git's global config, outside every working directory, never on argv, in the mount or in an error (§REQ603).
- **Image.** `git` is added to the AgentForge image.
- **Dogfooding.** An example in `packages/examples/` exercises the kind end to end.

## Capabilities

- **Modified: `filesystem-lifecycle`.**
  - Unmount keeps the local copy unless asked to remove it.
  - `delete` joins the baseline permissions when deletes are enabled.
  - Git-kind scenarios: a concurrent push, a conflict, deletes, `checkpoints` refused.
- **Modified: `harness-framework`.** Each framework renders `delete`.
- Whether the git kind is a capability of its own is for finalize (`openspec/guide/spec.md`, Capability granularity).

## Decisions

From the operator (2026-10-24) unless marked otherwise.

- **The kind sits behind the existing `Filesystem` interface**, and git is chosen over S3 Files because S3 Files needs a VPC.
- **Unmount keeps the local copy by default; removal is opt-in.**
  - The runtime session isolates the container on AgentCore and decides whether a mount persists.
  - Keeping the copy saves the traffic, latency and S3 read cost of re-pulling per task.
  - A task that failed or was cancelled leaves its work for the next task in the session, which is as often wanted as not.
  - This mutates ADR 0015's unmount rule in place. ADR 0015 is accepted, and no consumer depends on it yet.
- **Deletes are off by default and opt-in.** When enabled, the agent options each framework derives from the mounts grant delete on the write scopes.
- **Everything is on one branch**, `main` by default, set by the `branch` option. An environment may set the option, for example to target another branch in development. There is no branching per task, procedure or agent: branches would need pull requests or merging downstream, and TrendBot is single-branch.
- **The repository URL depends on the environment** (local dev, CI or cloud). It is declared through env files with the Nx semantics `.env.serve.local` already uses: `.env` for the default remote, `.env.serve.local` for a local repository. TrendBot mounts a host repository the same way (`trendbot-monorepo/packages/agents/src/harness/claude-agent-sdk/runtime/agentcore/container.ts:128-129, 260-291`).
- **Credentials live in Secrets Manager**, are rotated manually for now, and are consumed by the runtime. They are written to git's global config outside the working directories, where the read fence keeps the agent from reading them. If that holds, no credential proxy is needed yet and §ODO005's trigger is not met.
- **No automatic checkpoints for git.** Agent-driven checkpointing, through commit-and-push tools in the agent's tooling, is considered. With kept copies, the operator's view is that partial work is not lost anyway, so a push for the agent may not be needed at all.
- **Not carried over from TrendBot** (subsumed by AgentForge's lifecycle):
  - `enable`: a procedure registers the filesystem or does not.
  - `commit` without `push`.
  - `isResultOk`: the task state is what `pushOn` reads (§REQ206, §REQ103).
  - The per-mount mutex: AgentForge refuses and never queues (§REQ306), through the claim.
  - `spawnSync` and `Atomics.wait` backoff: these stalled `/ping` in the predecessor (`docs/lineage/predecessor-harness.md`). The kind spawns asynchronously, as `runS7cmd` does.

## Impact

- `libs/agentforge/src/server/harness/filesystem/`:
  - `filesystem.ts`: unmount keeps by default; `Permission` gains `delete`.
  - `s3-filesystem.ts`: deletes become a permission.
  - New `git-filesystem.ts`, with tests.
- `libs/agentforge/src/framework/{claude,strands}/`: rendering `delete`.
- `/agent` exports; `core/filesystem.ts`, for the repository declaration.
- `libs/agentforge/Dockerfile`: `git`.
- The Nx plugin's serve target: bind-mounting a local repository. `/infra`'s `AgentRuntime`: naming repositories and their secrets.
- Docs: `docs/ARCHITECTURE.md` (Filesystems, `/agent` table, §7 serve), ADR 0015, `docs/REQUIREMENTS.md`, `docs/GLOSSARY.md` if new terms arise.
- `claude-plugin/` skill, and `references/migrations.md`, since unmount's default changes what a consumer gets.
- An example in `packages/examples/` with its `e2e`, and `integ/local/filesystem-git`.

## Dependencies

- **ADRs**:
  - [0015](../../../adr/0015-filesystems-mount-around-a-procedure.md): unmount rule mutated; the git kind it anticipated.
  - [0011](../../../adr/0011-state-persists-through-apis-not-mounts.md): git is an API sync in that sense.
  - [0018](../../../adr/0018-the-agentforge-image-is-debian.md): `git` from Debian's apt.
  - [0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md): permissions are data the framework renders.
  - A git ADR (remote declaration, merge policy, credentials) to be written `proposed` at finalize.
- **Open design options**: §ODO005. Its trigger is not met if the credential stays unreadable to the agent (Open Questions 4).
- **Specs**: `openspec/specs/filesystem-lifecycle/spec.md`, `openspec/specs/harness-framework/spec.md`.
- **In-flight changes**: `package-tarball`, which touches nothing here.

## Open Questions

1. **Requirement.** No requirement names a filesystem's store; filesystems trace to §REQ401 and §REQ403. Proposed: **REQ405** — "A procedure's durable files may live in a version-controlled repository, so each change it persists is recorded with its history and author, and two writers' changes are merged or refused, never silently overwritten." Is that the wording, and is a new id right? Keeping the copy may also want its own requirement: "a later task in the same runtime session starts from the files an earlier one left".
2. **Kept copies outlive a task, but not the container.** AgentCore compute is ephemeral: memory and disk last only for the compute (`docs/research/agentcore-runtime.md:35`). The container goes with an idle timeout (15 min), `maxLifetime` (8 h), a deploy, a stop or a lost container. Kept copies save re-pulls, but they do not preserve unpushed work across a stop. That bears on the checkpoint decision (5):
   - Timer checkpoints are what a timed-out or lost task keeps today (ADR 0015).
   - Without them, or an agent-driven push, a git task whose container dies loses everything it did not push.
3. **Locally, one container serves every session.** `serve-<agent>` runs one container for all sessions ("Routed by the AgentCore session header, locally too", `docs/ARCHITECTURE.md:32`). There, a kept copy left by one session is reused by another session's task on the same directory. Options: accept the local difference (§REQ701), or tag each kept copy with its runtime session and refresh or remove it when another session mounts it.
4. **Is the credential unreadable to the agent?** That is the condition for §ODO005's trigger not being met. Three ways it is not, today:
   - **Environment.** Every declared secret is in the server's environment (`docs/ARCHITECTURE.md:146`). The executor gives it to the task process (`libs/agentforge/src/server/runtime/executor.ts:206-207`). The `claude` kernel passes `process.env` on to the CLI (`libs/agentforge/src/framework/claude/harness/kernel.ts:689`), so the agent's shell can print it. The token has to be withheld from the agent's environment, not only written to git's global config.
   - **The read fence covers less than it seems.** It covers `claude`'s file tools and read-only Bash, it is a house default a procedure may turn off, and it does not bound Bash that is not read-only (`docs/ARCHITECTURE.md:80`). `strands` has no read fence: its Cedar intervention refuses only edits outside the write scope.
   - **The agent's own `git`.** A Bash rule that lets the agent run `git` reads the global config without naming its path, for example `git config --global --list`, which no path fence sees. It would also push with the token to any repository on that host.

   Options: hold the token only in the task process's memory and pass it to each git child's environment, never to disk or the agent; or the global config, with the token stripped from what the agent inherits and `git` refused to the agent.
5. **Agent-driven commit and push.** Are tools given to the agent, rendered by each framework from the mounts? If so:
   - Does a push mid-task need `pushOn` to include `TASK_STATE_FAILED`, as checkpoints do, since it publishes before the outcome?
   - Does it apply to the git kind only, or to every kind?
   - Or none, accepting the loss in 2?
6. **What a pull over a kept copy does with work left unpushed.**
   - Git: the kept clone may hold local commits, or uncommitted changes, from a task that failed or was cancelled. Rebasing them keeps them, and the next completed task's push then publishes the earlier task's work too. Is that intended, or does a pull discard what the last task did not push?
   - S3: `s7cmd sync` from the bucket overwrites a locally changed file whose remote copy differs, and keeps files that exist only locally. So an unpushed edit can be lost while an unpushed new file survives.
7. **Disk.** Kept copies of distinct subpaths accumulate over a session's life of up to 8 hours. Is that bound needed (an eviction or size cap), or are the session's limits enough?
8. **Removal option.** Its name (for example `removeLocalCopy`), and whether it can be set per request or only per filesystem.
9. **A stale lock in a kept clone.** A cancel kills git children (they run in the task process), so a kept clone can be left holding `index.lock` or mid-rebase. TrendBot cleans these up (`git-lifecycle.ts:361-397, 717-729`); with kept copies AgentForge needs the same.
10. **How a subtree becomes the mount's root.** Git checks out a repository's root, but a mount is `<remotePath>` at `localPath`. Options:
    - (a) Plumbing over a private git directory: `read-tree -u` of the tree-ish `<base>:<remotePath>` into `localPath`, with its own index; on push, splice the written subtree back under `<remotePath>`.
    - (b) A sparse checkout, copied into `localPath` and back.

    Lean (a). To settle at finalize.
11. **Conflict policy.** The S3 kind lets the last writer win per object. A rebase merges hunks from two writers in one file, which can corrupt structured files.
    - (a) File-level: a file changed on the remote since the pull and by the task fails the push `FILESYSTEM_UNSYNCED`.
    - (b) Git's three-way merge; a textual conflict fails `FILESYSTEM_UNSYNCED`.
12. **Deletes.**
    - Does `dangerouslyEnableDeletes` keep its name for the git kind, where a delete is relative to the base and safe against others' writes?
    - Does its whole-store guard (`remotePath === '/'`) still apply there?
    - How does `claude` render `delete`? Claude Code has no delete tool; `rm` is Bash, and Bash rules match command prefixes, not paths. And `strands`: does its vended file tool delete?
13. **Branch from the environment.** Is there an AgentForge-named variable for it, or does the consumer set the option from a variable of its own?
14. **Repository declaration.**
    - The variable's name and shape, for example `AGENTFORGE_FILESYSTEM_REPOSITORIES` as `{ name: url }`.
    - How the cloud value reaches AgentCore's runtime environment: an `AgentRuntime` prop set from the infra project's env.
    - The local repository is a host directory, bind-mounted and reached as `file://`. Is a non-bare one refused? TrendBot wedged on a dirty non-bare hub (`git-lifecycle.ts:639-667`).
15. **Commit message and author.** A message function of `{ input, context }` or a default naming the procedure. A trailer with the task id, idempotency key and attempt (§REQ601). The author: an option, or `AGENTFORGE_AGENT_NAME`.
16. **`exclude` and `.gitignore`.** Does the git kind need `exclude`? A file in the write scope but ignored by `.gitignore` would be silently left out of the push: refuse it, force-add it, or fail on it?
17. **Retry bound and per-op timeout** for non-fast-forward and lock contention. TrendBot: 12 attempts, 250 ms–5 s jittered backoff, 20 s per op (`git-lifecycle.ts:591-601`).
18. **Clone shape.** Blobless plus a sparse checkout of `<remotePath>`, or `--depth` too? A shallow base makes the rebase depend on fetch deepening.
19. **Git in the base image.** It costs every agent a few tens of MB. Is it pinned beyond the base image's digest?
20. **Tests.**
    - `integ/local/filesystem-git` against a `file://` bare repository.
    - Whether a live slice against a hosted remote earns its cost (credential from `.env.integ.local`).
    - Which example dogfoods the kind: `smoke-coverage`, or a new one.
21. **One change or two.** The kept-copy and delete-permission changes apply to every kind and stand without git. Split them into their own change, which `git-filesystem` depends on?

## Notes

### Compatibility of TrendBot's git lifecycle with AgentForge's filesystem

Paths:
- AgentForge's are relative to the repository root. `filesystem.ts`, `s3-filesystem.ts` and `mount-claims.ts` live in `libs/agentforge/src/server/harness/filesystem/`.
- TrendBot's are in `trendbot-monorepo/packages/agentforge/src/runtime/agentcore/trpc/middleware/` unless named otherwise.

The verdicts are against AgentForge as built. The Decisions above change the unmount, checkpoint, delete and branch rows.

| Point | Verdict | AgentForge | TrendBot | Note |
|---|---|---|---|---|
| Lifecycle around a procedure | Direct | The harness middleware mounts innermost and unmounts after the outcome (ADR 0015; `filesystem.ts:185-218, 331-355`) | Middleware wraps `opts.next()`: pre-sync, run, post-commit (`git-lifecycle.ts:880-914`) | |
| `pull` | Adaptation | Every mount pulls into `localPath` (`filesystem.ts:173-174, 201-203`) | Clones once per container, then fetches and rebases per request (`git-lifecycle.ts:412-453, 490-496`) | With kept copies, close to TrendBot's: clone once, then fetch and rebase. Open questions 6, 10, 18 |
| `push` | Adaptation | Sends the write scope's changes and is verified before the outcome (`filesystem.ts:176-180`) | `add -A`, commit, then fetch, rebase and push with retry (`git-lifecycle.ts:520-573, 743-802`) | A push is an atomic ref update with hash integrity, so verified by construction. A no-op push is success, where TrendBot only warns (`:535-545`). Open question 17 |
| `localRoot` | Direct | Absolute; the kind defaults it or requires it (`filesystem.ts:40-41, 162-170`) | `mount`, the clone root (`git-lifecycle.ts:26-27`) | Required, as for S3 |
| `remoteRoot` / `subpath` | Adaptation | One subtree, `<remoteRoot>/<subpath>` mounted at `<localRoot>/<subpath>` (`filesystem.ts:27-36, 224-259`) | Repository-relative sparse patterns, cumulative (`git-lifecycle.ts:28-41, 478-483`) | A subtree is not git's checkout root (open question 10). TrendBot's widened read set, such as a parent's `_origin.md` (`agents/src/agent/entity/router.ts`), becomes a wider subpath with narrower `write` globs, since a mount is readable whole (`filesystem.ts:231-235`) |
| `scope.write` | Adaptation | Bounds every push (`filesystem.ts:34, 243-249`; `s3-filesystem.ts:156, 210-215`) | None: `partial` guards visibility, and the commit is everything written (`git-lifecycle.ts:502-511, 532`) | Select changed files in TypeScript by the globs `writablePath` matches (`filesystem.ts:293-301`). A git pathspec that matches nothing exits 128 (`git-lifecycle.ts:506-510`) |
| `pushOn` | Direct | `TASK_STATE_COMPLETED` and/or `TASK_STATE_FAILED`, never a cancel (`filesystem.ts:13-17, 45-50, 338-341`) | Commits only on `result.ok`, gated by `isResultOk` (`git-lifecycle.ts:886-902`) | TrendBot's behaviour is `pushOn: ['TASK_STATE_COMPLETED']` |
| `checkpoints` | Refused by the git kind (decided) | A timer push of files that have settled (`filesystem.ts:51-55, 92-97, 309-328`) | Agent-driven: `ctx.gitLifecycle.commitPush` from a `PostToolUse` hook (`git-lifecycle.ts:106-113, 845-852`; `discovery/router.ts:184-186`) | Open questions 2, 5 |
| `exclude` | Adaptation | An S3 option (`s3-filesystem.ts:29-30, 189-193`) | None; `.gitignore` applies implicitly | Open question 16 |
| `dangerouslyEnableDeletes` | Adaptation; the semantics differ | Off by default. On, the final push deletes every object in the write scope with no local file, including others' writes since the pull; needs remote path ≠ `/` (`s3-filesystem.ts:21-28, 118-125, 146-152`) | Always stages deletes (`git-lifecycle.ts:530-532`) | In git a delete is relative to the base, so another writer's new file survives the rebase. Open question 12 |
| Per-directory claim | Direct, and contrary to TrendBot | One live task per local directory, refused `FILESYSTEM_UNSYNCED` (`mount-claims.ts:25-33`) | Sibling requests queue on an in-process mutex (`git-lifecycle.ts:877-880`) | AgentForge refuses, never queues (§REQ306). The claim still ends at unmount; the kept copy is not a claim |
| Unmount | Changed (decided) | Pushes per `pushOn`, then removes `localPath` (`filesystem.ts:331-355`) | The clone persists across requests (`git-lifecycle.ts:345-359`) | The copy is now kept by default. A kept clone needs TrendBot's stale-lock handling (open question 9) |
| `FILESYSTEM_UNSYNCED` | Adaptation | A kind throws `FilesystemUnsynced`, which becomes a retryable cause (`filesystem.ts:132-133, 385-391`) | Plain `Error`s; transient ones retried, conflicts surfaced (`git-lifecycle.ts:609-686`) | `FilesystemUnsynced` for remote, auth and conflict failures. A plain `Error` for a missing token or an undeclared repository, before mounting, as `S3Filesystem.validate` does (`s3-filesystem.ts:118-125, 168-177`) |
| Credentials | Adaptation | Each layer declares its secrets; Secrets Manager fills the environment (`docs/ARCHITECTURE.md:146`); never emitted (§REQ603) | `pushTokenEnvVar` turned into an extraheader through `GIT_CONFIG_*` on `process.env` (`git-lifecycle.ts:186-226`); token from AgentCore Identity (`identity-resolver.ts:5-25`) | Open question 4 |
| Remote selection | Adaptation | The bucket is named in options and mapped by `AGENTFORGE_FILESYSTEM_BUCKETS` (`core/filesystem.ts:3-8`; `s3-filesystem.ts:168-182`) | `TRENDBOT_VAULT_REPO`: a `file://` hub locally, `https://` in the cloud (`agents/src/shared/trpc/init.ts:61-66`) | Decided: env files. Open question 14 |

### Where git's semantics differ from S3's

- **Commits, not objects.** A push is one atomic commit and ref update, so a lost container never leaves half a push. It adds a message and an author, and every push adds to history.
- **Concurrent pushes contend on the branch, not the path.** Two tasks on disjoint subpaths never contend in S3. In git both advance one ref, so non-fast-forward is routine and the kind must fetch, rebase and retry. Two tasks on one subpath across containers remain the consumer's to prevent (ADR 0015, "Mechanics, not policy").
- **Conflicts are detected, not overwritten** (open question 11).
- **Deletes are relative to the base**, so they are safe against others' writes.
- **History** makes a bad push recoverable.
- **The remote needs a credential AgentForge does not own.** S3 uses the runtime's role; git needs a token (open question 4).
