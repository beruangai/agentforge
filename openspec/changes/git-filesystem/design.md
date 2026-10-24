# Design

Guidance, not prescription: adapt to what the code finds. Motivation is in `proposal.md`; behaviour is in the spec deltas.

## Context

The base lifecycle and its two kinds:
- `Filesystem` (`libs/agentforge/src/server/harness/filesystem/filesystem.ts`) resolves a scope into a `Mount`, claims its directory, pulls, and runs checkpoints.
- `MountLifecycle.unmount` pushes per `pushOn`, removes the copy and releases the claim.
- `S3Filesystem` syncs with `s7cmd`; `ScratchFilesystem` is an empty directory.
- Each framework's `toAgentOptions` renders mounts: `claude` (`framework/claude/harness/agent-options.ts`) and `strands` (`framework/strands/harness/agent-options.ts`).
- Secrets reach every task process through the server's environment (`server/runtime/executor.ts:206`), and the `claude` kernel hands `process.env` to the CLI (`framework/claude/harness/kernel.ts:689`).
- Git is not in the image.

Spiked on 2026-10-24 ([research](../../../docs/research/git-filesystem.md)):
- git plumbing mounts a subtree as a work tree root and splices it back;
- `merge-tree --write-tree` merges in memory and names a conflicting file;
- the image's Debian 13 installs git 2.47.3.

### What TrendBot's lifecycle maps to

Evidence from `trendbot-monorepo/packages/agentforge/src/runtime/agentcore/trpc/middleware/git-lifecycle.ts`. "Ours" is this design.

| Point | TrendBot | Ours |
|---|---|---|
| Clone | One per container, kept, fetch and rebase per request (`:412-496`) | One per local directory, kept with the copy, fetch and in-memory merge |
| Scope | Repository-relative sparse patterns, cumulative (`:28-41, 478-483`) | One subtree as the mount's root; a wider read set is a wider subpath with narrower `write` |
| Commit scope | Everything written, `add -A` (`:502-532`) | The write scope only, matched as `writablePath` matches, minus `exclude` |
| When | On `result.ok` and `isResultOk` (`:886-911`) | `pushOn`; the task state replaces `isResultOk` |
| Mid-run | `ctx.gitLifecycle.commitPush` from a hook (`:845-852`) | The mount's offered push, rendered as a tool |
| Contention | Rebase and retry, with `spawnSync` and `Atomics.wait` (`:591-802`) | Async spawn, merge in memory, refuse a shared file, bounded retry |
| Concurrency in a container | An in-process mutex queues (`:877-880`) | The claim refuses (§REQ306) |
| Credentials | An extraheader set once on `process.env` (`:186-226`) | The same header in each git child's environment only; the secret is removed from `process.env` |
| Remote | `TRENDBOT_VAULT_REPO` per environment | A named repository, mapped by the deployment |
| Dropped | `enable`, `commit` without `push`, stale state from a dirty tree (`:494-495`) | Subsumed by registration, `pushOn`, and a work tree never mid-rebase |

## Goals / Non-Goals

**Goals:**
- One `Filesystem` kind for git with `S3Filesystem`'s option set where git can honour it.
- A kept local copy for every kind, scoped to a runtime session.
- No credential reachable from an agent's environment.

**Non-Goals:**
- A shared object store between two local directories' clones in one container. Each clone is its own; the duplication is bounded by the session.
- Eviction of kept copies. On AgentCore a session's 8-hour life and its disk bound them; locally one container serves every session until it is stopped, so they are bounded only by restarting serve.
- An S3 agent push. S3 keeps its timer checkpoints.

## Decisions

### Public API

```ts
// /agent — filesystem.ts, shared options
export interface FilesystemOptions {
  // …unchanged…
  /** Remove the local copy at unmount. Off: the next task in this runtime session that mounts the same directory starts from it. */
  readonly removeLocalCopy?: boolean;
}

export type PermissionAction = 'read' | 'edit' | 'delete';

export interface MountedFilesystem {
  readonly localPath: string;
  readonly permissions: readonly Permission[];
  path(relativePath: string): string;
  writablePath(relativePath: string): string;
  /** Present only where the kind offers the agent a push and `pushOn` includes `TASK_STATE_FAILED`. */
  readonly push?: (message: string) => Promise<PushReport>;
}

export interface PushReport {
  /** The commit pushed; absent when there was nothing to record. */
  readonly commit?: string;
  /** Relative to the mount. */
  readonly files: readonly string[];
}

// Mount gains the request, so a kind can read the task's identifiers and runtime session.
export interface Mount { /* …unchanged… */ readonly request: FilesystemRequest }

// /agent — git-filesystem.ts
export interface GitFilesystemOptions extends Omit<FilesystemOptions, 'checkpoints'> {
  /** Required, as for S3. */
  readonly localRoot: string;
  /** The name the deployment maps to a location (AGENTFORGE_FILESYSTEM_REPOSITORIES). */
  readonly repository: string;
  /** Default 'main'. */
  readonly branch?: string;
  /** The environment variable of a declared secret holding the remote's token; needed for https. */
  readonly tokenVariable?: string;
  /** Default `agentforge: <filesystem name>`; trailers are added either way. */
  readonly message?: (request: FilesystemRequest) => string;
  /** Default: AGENTFORGE_AGENT_NAME <name@agentforge.invalid>. */
  readonly author?: { readonly name: string; readonly email: string };
  /** As S3's: never pulled into the commit, pushed or deleted. */
  readonly exclude?: readonly string[];
  readonly dangerouslyEnableDeletes?: boolean;
}
export class GitFilesystem extends Filesystem {
  constructor(options: GitFilesystemOptions, seams?: { git?: GitRunner; environment?: NodeJS.ProcessEnv });
}

// core/filesystem.ts
export const FILESYSTEM_REPOSITORIES_VARIABLE = 'AGENTFORGE_FILESYSTEM_REPOSITORIES'; // { name: location } JSON
// One parser for both declarations; parseDeclaredBuckets becomes parseDeclared(FILESYSTEM_BUCKETS_VARIABLE, …).
export function parseDeclared(variable: string, value: string | undefined): Readonly<Record<string, string>>;

// /infra — AgentRuntime props
readonly repositories?: Readonly<Record<string, string>>; // name → https:// URL
```

`Filesystem`'s protected surface:
- A kind may override `storeIdentity(mount)` (what its store is), `privatePaths(mount)` (state of its own beside the directory, removed with the copy) and `agentPush(mount, message)`, which is what makes `MountedFilesystem.push` present.
- The constructor's `kind` argument gains `deletes: boolean`, which adds the `delete` permissions.

### Kept copies (base lifecycle)

- **At unmount**: push per `pushOn`. Then, if `removeLocalCopy`, remove the copy's paths and its marker. Always release the claim.
- **The copy's identity.** Each kept copy has a marker beside the claims, never inside the mount: `<tmpdir>/agentforge-mounts/kept/<sha256(localPath)>.json`, holding `{ localPath, kind, store, remotePath, runtimeSessionId }`.
  - `store` is the kind's own identity of its store: S3, the declared bucket's resolved name; git, the repository's resolved location and branch. It comes from a protected `storeIdentity(mount)`.
  - The marker also lists `paths`: the copy's local directory and any private state the kind keeps for it (git: its private directory). A kind adds its own through a protected `privatePaths(mount)`.
  - At mount, after the claim, every marker whose `localPath` is the mount's or around or inside it is read. Any that does not match this mount's identity and session in full has every path it lists removed, then the marker. The base needs no knowledge of a kind and no live instance of it, so a consumer's own kind is cleaned the same way.
  - Then the mount's marker is written.
  - Locally, this makes one container behave as AgentCore's one session per container; it also keeps a copy from crossing to another store.
  - A directory with no marker is left as it is today.
  - The claim already refuses a live mount around or inside, so only dead copies are ever removed.
- **Removal**: `ScratchFilesystem` always sets `removeLocalCopy`. A failed pull still removes the copy and its marker, as today, so a partial download is never kept and later published as a local change. Removing a copy, at unmount or after a failed pull, always removes its marker.
- **Rejected alternatives**:
  - Keeping removal as the default: re-pull cost (proposal).
  - Keying the copy by session in its path: a subpath is the consumer's; changing the path would change what prompts name.

### Pull over a kept copy

- **S3**: `s7cmd sync` as today. Its default comparison by modification time gives the spec's "the later of the two" (research). It runs without `--delete`, so a store deletion does not reach the copy, and a push may restore the file. That is accepted and documented: preventing it is the procedure's, by `removeLocalCopy` or by partitioning writers (operator, 2026-10-24). `s7cmd`'s log of what it transferred is the record of what a pull replaced.
- **Git**: fetch the tip `T`. If `T` is the base, only tracked files missing from the copy are restored from the index (`checkout-index` of the deleted paths), so a local deletion never survives a pull. Otherwise:
  - `L` is the local changes against the mount's index, without deletions;
  - `U` is the paths changed `base..T` under the remote path;
  - back up `L \ U`, `read-tree -u --reset T:<path>`, restore the backups, and set the base to `T`.

  A local deletion is undone, as S3's pull restores a missing file. Each path in `L ∩ U` is logged as discarded, naming the mount (`console.warn`, which reaches the task's log). One routine, `advanceTo(commit)`, serves both a pull and the state after a push. After a push it first records the pushed files in the mount's index, so its own files are never logged as discarded.

### Git: storage and mount

- **Private directory**: `<tmpdir>/agentforge-git/<sha256(localPath)>/`.
  - A bare, blobless, single-branch clone (`--filter=blob:none`, no `--depth`), made in a temporary directory and renamed into place, so a killed clone leaves nothing half-made.
  - The mount's own index file.
  - The base as `refs/agentforge/base`.
- **Removal**: listed in the marker through `privatePaths`, so it is removed with the mount's copy.
- **Stale locks**: every `*.lock` in it is removed at mount, since the claim guarantees no live user.
- **Paths**: the remote path `/` is the base's root tree; another path is `<base>:<path without leading slash>`. A missing path mounts the empty tree.
- **An empty repository**: a branch that does not exist yet (`ls-remote` finds nothing) mounts empty with no base, and the first push is a root commit.

### Git: push

1. **Changes.** Modified and deleted files (`diff-files`) and untracked files (`ls-files --others`, without `--exclude-standard`), relative to the mount.
   - Kept: files a write glob matches (`matchesGlob`, as `writablePath`), unless `exclude` matches. Deletions only when deletes are enabled.
   - `.gitignore` is not consulted: the mount's root is not the repository's, so repository-level ignores would not apply consistently. `exclude` is the one declaration, as for S3.
2. **Nothing kept**: return `{ files: [] }`.
3. **Commit.** Stage into a copy of the mount's index (`update-index --add --remove`), `write-tree`, splice under the remote path in a scratch index from the base, and `commit-tree -p <base>`.
   - The message is `message(request)` and three trailers: `AgentForge-Task-Id`, `AgentForge-Idempotency-Key`, `AgentForge-Attempt`.
   - Author and committer come from `author`.
4. **Push**: `push origin <commit>:refs/heads/<branch>`. On a non-fast-forward:
   - fetch `T`;
   - refuse when `paths(base..T) ∩ paths(base..commit)` is not empty, with `FilesystemUnsynced` naming them;
   - otherwise `merge-tree --write-tree --merge-base=<base> T <commit>` (a non-zero exit is also refused), `commit-tree -p T` with the same message, set the base to `T`, and try again.
5. **Bounds.** 8 attempts with full-jitter backoff between 250 ms and 5 s, waited asynchronously. Lock contention and timeouts retry like a non-fast-forward.
6. **After success**: `advanceTo(pushed)`.
- **Rejected**: rebasing in a work tree, which can leave the tree mid-rebase when killed (TrendBot's stale-state handling exists for it); git's textual merge (ADR 0024).

### Git: agent push

- `agentPush` is the same push with the agent's message, queued with every other push of the mount (`MountLifecycle`'s queue, now taking any thunk).
- It is offered only when `pushOn` includes `TASK_STATE_FAILED`.
- Rendering:
  - `claude`: an in-process SDK MCP server `agentforge`, with `alwaysLoad: true` so tool search does not defer it, a tool `push_<name>` per offering mount, and `mcp__agentforge__push_<name>` added to `allowedTools`.
    - One server instance holds one transport. Read in SDK 0.3.280's source: a query connects each SDK server when it starts, and closes every transport when it ends. So one instance serves runs in sequence, but a second run while the first is live fails to connect, and the SDK only logs that.
    - `claude`'s `agent-options` therefore registers a factory for each server it creates (a `WeakMap` from instance to factory, in the `claude` folder). The kernel, starting a run, replaces a registered instance that is still connected with a fresh one from its factory. A consumer's own SDK server is untouched.
    - Recorded in `docs/research/claude-agent-sdk.md`, with a unit test of the replacement. No `integ/model` case: the kernel replaces any registered instance still connected, so it is correct whether or not the SDK keeps closing transports at a query's end, and a drift there costs at most a fresh instance per run.
  - `strands`: a tool `push_<name>` added to `tools`.
  - Both take `{ message: string }` and return the `PushReport`, or the failure's message as a tool error.
  - The full tool name counts against the 64-character limit: `mcp__agentforge__push_<name>` for `claude` (22 characters plus the name), `push_<name>` for `strands`. A longer one fails when the options are derived. The `repository` option is validated against `FILESYSTEM_NAME_PATTERN`, as `bucket` is, since it becomes a mount path.
  - `composeOptions` already accumulates both.

### Git: credentials

- **At construction**, a `tokenVariable` that is set in the environment is read, held in a module-level map, and deleted from `process.env`. This happens before any handler runs, since the procedures module constructs its filesystems on import.
  - What the deletion reaches (probed 2026-10-24 on Bun 1.4.0, [research](../../../docs/research/git-filesystem.md)): `node:child_process` children, and both kernels' runs (`claude` passes `env` explicitly; Strands' shell tool passes `{ ...process.env }`), no longer see it.
  - What it does not: a `Bun.spawn` child started without an explicit `env` still inherits the startup environment, token included. The skill tells a handler to spawn through `node:child_process` or pass `env` explicitly, and the `integ/local` case probes a `node:child_process` child, so the behaviour is caught if it drifts.
- **Not required**: the token is in `AgentRuntime`'s `secrets` but not in any layer's `REQUIRED_SECRETS`. The server reads every declared secret but requires only the required ones (`server/runtime/server.ts:207-210`), so a local serve against a `file://` repository needs no token set, while an https mount without one fails `EXECUTION_ERROR` before mounting.
- **At mount (`validate`)**:
  - `https://` needs a token, else `EXECUTION_ERROR` naming the variable;
  - `file://` needs none;
  - any other scheme, or a URL with userinfo, is `EXECUTION_ERROR`.
- **Each git child's environment**: `GIT_CONFIG_COUNT`, with `http.https://<host>/.extraheader = AUTHORIZATION: basic <base64("x-access-token:" + token)>` and `safe.directory=*`. The latter lets a host repository owned by another uid serve a local run. Also `GIT_TERMINAL_PROMPT=0` and an empty `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`, so nothing ambient leaks in.
- **Redaction**: the git runner never streams a child's stderr raw. It redacts the token and the header value to `***` before writing it to the task's log and before it becomes a cause.
- **One child runner** for both kinds: `runS7cmd`'s spawn, stderr tail and missing-binary message become one helper, `runChild({ command, args, env?, timeoutSeconds?, redact? })`. `s7cmd` and git each call it with their own binary, bound and redaction.
- **What it does not cover**: `/proc/<pid>/environ` of the task process keeps the initial environment, the token included, readable by a shell the read fence does not bound. That is recorded, and §ODO005 is deferred again on 2026-10-24 in `DESIGN_OPTIONS.md` (operator).
- **Rejected**: git's global config (ADR 0024).

### Repository declaration

- **The variable**: `AGENTFORGE_FILESYSTEM_REPOSITORIES` is `{ name: location }`.
- **Locally**: Nx loads the project's `.env` into every target and `.env.serve` and `.env.serve.local` into serve, the later winning. A project whose `.env` names a default remote therefore overrides it in `.env.serve` or `.env.serve.local` with a host directory, or a local serve pushes to that remote. The example declares only `.env.serve`, with a host directory. A repository several projects share is declared in the workspace root's files, which Nx loads after the project's (§ Seeding a host repository).
- **The serve executor**: for a location that is an absolute or workspace-relative path,
  - creates the bare repository if absent (`git init --bare -b main`, `uploadpack.allowFilter`), as it creates a missing bucket;
  - bind-mounts it at `/mnt/agentforge-repositories/<name>`;
  - passes `file:///mnt/agentforge-repositories/<name>`.

  An `https://` location is passed as it is.
- **On AgentCore**: `AgentRuntime({ repositories })` sets the variable. The token is an ordinary declared secret in `secrets`.
- **Branch**: from the option only, `main` by default. A consumer that wants another branch per environment sets the option from a variable of its own in its shared options; AgentForge names none.

### Seeding a host repository

A host repository that serve creates empty has a history unrelated to the repository's remote, so it can never be synced with it later. StrategyFoundry sets one up by hand today. The `seed-repository` target seeds it from the remote instead.

- **The target**: `seed-repository`, executor `@beruangai/agentforge:seed-repository`. Its options are given on the command line:
  - `repository`, the name `AGENTFORGE_FILESYSTEM_REPOSITORIES` and a git filesystem's `repository` use;
  - `remote`, `https://` only;
  - `location`, absolute or workspace-relative;
  - `readingClone`, optional.
- **Workspace level, run from any project.** Everything it creates and declares belongs to the workspace: the host location, and the workspace root's `.env.serve` or `.env.serve.local`.
  - Nx 23.3 loads a task's env files from the project root first and then from the workspace root, and the first definition of a variable wins (`getEnvPathsForTask`). So the workspace's declaration reaches every agentic project's `serve-<agent>` and the workflow project's `serve`, unless a project's own file defines the variable.
  - The workflow project's serve runs from the workspace root, so a workspace-relative location means the same directory to its worker.
  - The target is vended on every agentic and workflow project, not once at the workspace. Nx has no workspace-level target without a root project, which AgentForge does not own. The local store and the Temporal server already set the precedent: a target on each project over state the machine shares.
- **Default location**: `.agentforge/repositories/<repository>.git`. It is workspace-relative, so its declaration in `.env.serve` can be committed. A location inside the workspace that `git check-ignore` does not report gets its workspace-relative path appended to the workspace's `.gitignore`. That keeps it out of version control and out of Nx's file graph.
- **Creating**:
  1. Validate the remote: a URL with the `https:` scheme and no user name or password. Anything else fails before anything is created.
  2. Clone into a temporary sibling, `<parent>/.<basename>.seeding-<uuid7>`, with `git clone --bare <remote>`. The clone keeps the remote's branches and its `origin`.
  3. Set `uploadpack.allowFilter`.
  4. Rename the sibling into place.

  A failure removes the temporary sibling, which is the target's own. Nothing pushes, and nothing fetches later; `origin` stays for an explicit sync.
- **An existing location** is adopted only when it is a bare repository of the same remote.
  - A bare repository is one whose `git rev-parse --absolute-git-dir` is the location itself, not a workspace around it.
  - Its `remote.origin.url` must equal the remote, compared after dropping a trailing `/` and `.git`.
  - Adopting it adds `uploadpack.allowFilter` if missing. This adopts StrategyFoundry's existing `git clone --bare`.
  - Anything else fails, naming the path: a working clone, an empty or other directory, a bare repository with no `origin`, or one with another `origin`.
- **The declaration**:
  - The entry is merged into the variable's JSON in the workspace root's `.env.serve` (relative location) or `.env.serve.local` (absolute). The variable's line is replaced and every other line is kept. An entry already naming another location fails.
  - A file that defines the variable replaces it whole, since its value is one JSON value. So the target then reads the variable as each agentic and workflow project's serve would load it, through Nx's own `getEnvPathsForTask` and `util.parseEnv`. If any project would not see this entry, the target fails, naming the file that masks it: a project's own `.env.serve`, say, or the workspace's `.env.serve.local`.
- **The reading clone**:
  - When it is absent, `git clone <location> <readingClone>`.
  - When it exists, it must be a working clone at its own root that shares a commit with the host repository: some commit of `rev-list --all` in both. Then its `origin` is set to the location, or added, and the previous URL is printed.
  - Otherwise the target fails, naming it.
- **Credentials**: the host's own git, with its environment and configuration (a credential helper, `gh`). The target reads no token variable and sets no credential. Git's output is shown as it is. It carries no secret, because the URL has none and git prints no credential.
- **Serve's empty-repository fallback stays, for a repository with no remote.** When serve creates one, it logs that it did and names `seed-repository` for a repository with a remote.
  - Refusing was rejected. A repository with no remote, like the example's, would then need a seeding step with nothing to seed from.
  - A host repository created empty and then seeded fails loudly (no `origin`). It never silently joins two histories.

### `delete` permission

- The base adds `{ action: 'delete', glob }` per write glob when the kind says it deletes. That is S3's and git's `dangerouslyEnableDeletes`.
- `claude`'s renderer today renders every action that is not `read` as `Edit` (`framework/claude/harness/agent-options.ts:23`). This change makes it map `read` and `edit` only, pinned by a unit test. `strands`' already filters to `edit`. Neither renders `delete`: neither SDK has a delete tool, and a Bash rule cannot bound paths (`Bash(rm <dir>/*)` also matches `rm <dir>/x /etc/passwd`).

### Image

`apt-get install --no-install-recommends git` beside `ca-certificates`, pinned by the base image's digest as the rest of apt is. About 29 MB.

### Error handling

| Failure | Raised as | Task outcome |
|---|---|---|
| Undeclared repository, unsupported scheme, userinfo in URL, https without a token, deletes at `/` | `Error` in `validate` | `FAILED`, `EXECUTION_ERROR`, before mounting |
| `checkpoints` on a git filesystem; an invalid branch name | `Error` at construction | The procedures module fails to load: `EXECUTION_ERROR` |
| `git` not on the `PATH` | `Error` naming the image | `EXECUTION_ERROR` |
| The remote refused the token (HTTP 401 or 403, `Authentication failed`, a credential prompt git could not answer) | `TaskFailure` with cause `CREDENTIAL_EXPIRED`, naming the token variable | `FAILED`, `CREDENTIAL_EXPIRED`, not retryable: it needs an operator, and rotation is manual (§ODO005) |
| Clone, fetch or push failed, timed out, or retries ran out; a file changed by both writers | `FilesystemUnsynced` | `FILESYSTEM_UNSYNCED`, retryable. A completed task ends `FAILED`; a failed one keeps its cause with the push's added (unchanged) |
| An agent's push failed | A tool error result | The task continues |

Every git child is spawned without a shell, as a child of the task process, so a cancel takes it. Each is bounded at 300 s, and killed after that as unsynced.

### Tests

- **`test`** (units, no git): kept-copy markers and removal; `delete` permissions; the offered push and its queue; validation and errors; redaction; the change selection by globs and `exclude`; both renderers' push tools and `delete` rendering nothing.
- **`integ/local/filesystem-git`**, against real git and bare `file://` repositories:
  - mount of a subtree, and an empty one;
  - a push of the write scope only;
  - a disjoint concurrent push merges; a shared file is refused;
  - deletes on and off, and another writer's file surviving a delete;
  - a kept copy across two mounts, and another session's copy removed;
  - an agent push mid-task;
  - no token in the environment, and none in a cause.

  This is AgentForge's composition of git, which the platform does not guarantee.
- **`integ/local/seed-repository`**, against real git and a remote served over HTTPS from a temporary bare repository: git's dumb HTTP protocol (`update-server-info`), and a self-signed certificate that the test trusts through `GIT_SSL_CAINFO`. It covers:
  - a fresh default location, whose `main` matches the remote's;
  - a GitFilesystem mounting the seeded history and pushing, with the remote's refs unchanged;
  - a re-run changing no file;
  - adopting a hand-made `git clone --bare` without `uploadpack.allowFilter`;
  - a working clone failing with its path named;
  - a URL with userinfo failing before cloning;
  - a reading clone created and one re-pointed, fetching the pushed commit;
  - a masking project file named;
  - no credential in any file written.

  The served path over a host repository is covered by `smoke-coverage`'s e2e. A served agent over a seeded repository would need an HTTPS remote in the e2e, which waits with the hosted remote (Non-goals).
- **`integ/aws/filesystem-s3-sync`**: one more case, a pull over a kept copy keeping a newer local edit. It is `s7cmd` behaviour AgentForge now relies on, and it could move with a release.
- **e2e local** (`smoke-coverage`): a procedure on a git filesystem, through the client, against the serve target's host repository.
  - The first task's agent writes a file in the write scope and calls its push tool. The host repository then holds that commit, with the agent's message and the trailers, which proves the tool's rendering under `dontAsk`.
  - It also writes a file outside the write scope, which the store never has. The second task in the same session finds that file, which proves the kept copy carried.
- **Existing e2e**: `smoke-coverage`'s S3 note and memory round trips read back in another runtime session, so they still prove the store, not a kept copy. Every example's local e2e is re-run (`golden-kata`, `smoke-coverage`, `strands-smoke`, `research-brief`), since the default changed for every kind.
- **Host prerequisite**: `integ/local` and the serve executor need `git` on the `PATH`, ≥ 2.40 for `merge-tree --merge-base`. Added to `.claude/rules/testing.md`'s `local` row.
- **Settled once**, not tested: git's plumbing semantics (research note); GitHub's extraheader authentication (documented).
- **Not tested**: the AgentCore e2e against a hosted remote (Non-goals in `proposal.md`).

## Risks / Trade-offs

- **Unpushed work is lost when the container stops.** A kept copy survives the task, not the container. V2's snapshot is one per runtime version, taken at its first healthy `/ping`, so a stopped session resumes on fresh compute restored from it, without the copy (`docs/research/agentcore-runtime.md`, Sessions and Platform version V2). → The agent push, when `pushOn` includes `TASK_STATE_FAILED`.
- **An S3 kept copy can restore another writer's deletions.** → Accepted and documented. The procedure removes its copy or partitions writers.
- **The first agent run of a task process could see the token** if a procedure constructs its `GitFilesystem` inside a handler. → Documented: construct filesystems at module scope, as generated code does. The construction removes it before any later run.
- **`/proc/<pid>/environ` keeps the task process's initial environment.** → Fenced reads cover it for `claude`; otherwise recorded, not mitigated, as for every secret (§ODO005).
- **A kept copy can hold a failed task's half-written files, and the next completed task's push publishes them.** → That is what keeping means (proposal). `removeLocalCopy` opts out.
- **Two writers on one file never merge.** → The retry pulls the new tip. Consumers partition by subpath, as for S3.
- **Each local directory keeps its own clone.** → Blobless, bounded by the session.
- **A project's own `.env.serve` masks the workspace's repositories**, because Nx loads the project's file first and a variable is one value. → The seeding target fails, naming the masking file; the guidance says to declare repositories at the workspace root.

## Migration Plan

- Consumers' filesystems now keep their local copies. Anyone relying on removal sets `removeLocalCopy: true`. This goes in `claude-plugin/skills/agentforge/references/migrations.md`.
- Sync adds `seed-repository` to every agentic and workflow project. A host repository set up by hand from a remote is adopted by running it once; this also goes in `migrations.md`.
- The `delete` permission is additive; handlers that iterate permissions see a new action only where deletes are enabled.
- Rolling back is a revert; there is no persisted state outside the container.
