# Proposal

## Why

StrategyFoundry needs durable storage for its core artifacts, with history. S3 Files, a mounted S3 filesystem, needs VPC network mode, which AgentForge tabled as a default (`docs/DESIGN_OPTIONS.md`, Tabled: Mounts; [ADR 0011](../../../adr/0011-state-persists-through-apis-not-mounts.md)). StrategyFoundry will instead adopt the git-based storage TrendBot runs on, built into AgentForge as a `Filesystem` kind with the S3 filesystem's semantics. [ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md) anticipated it: "git comes later".

TrendBot's git lifecycle is evidence, not a specification (`docs/lineage/predecessor-harness.md`). The review behind this change compared it point by point with AgentForge's filesystem; the table is kept in the design. It also found AgentForge's own unmount too aggressive for every kind. Removing the local copy after every task re-pulls the same mount for every task in a runtime session: traffic, latency, and for S3, reads paid per task. Yet the runtime session already isolates the container, and a task that failed is as often helped as harmed by starting from what it left.

## What Changes

- **Unmount keeps the local copy by default**, for every kind; removing it is declared per filesystem. How long a copy lasts is then governed by the runtime's own lifecycle settings — idle timeout, maximum lifetime — rather than by AgentForge.
  - A later task that mounts the same directory, for the same store, starts from the copy, brought up to date by its pull.
  - A copy left by another runtime session, for another store, or around or inside the directory, is removed before the mount. So a container serving several sessions (locally) behaves as AgentCore's one session per container does.
  - The scratch kind still removes its directory.
  - An S3 copy does not take another writer's deletions, and its push may restore them. Preventing that is the procedure's choice: remove the copy, or partition writers by subpath.
  - **BREAKING** for a consumer that relies on removal: it declares removal.
- **Deletes are a permission.** When a filesystem enables deletes, its mount's baseline permissions add `delete` on each write glob, as data. No framework renders it; deleting stays with the procedure's own shell allow list.
  - This departs from the operator's first direction, that the derived options grant delete. Neither SDK has a delete tool, and a shell rule cannot bound paths. The operator chose data-only on 2026-10-24.
- **A git filesystem**, a third built-in kind:
  - It mounts a subtree of one branch of a repository, `main` by default.
  - Its push is one commit of the write scope's changes onto the base it pulled, merged onto the remote tip and pushed.
  - A push is refused `FILESYSTEM_UNSYNCED` when a file it changed was also changed on the remote since its pull.
  - It has no timer checkpoints. When it pushes on `TASK_STATE_FAILED`, the agent gets a push tool, so the agent decides when partial work is worth publishing.
  - The repository is named, and each deployment's environment maps the name to a URL. Locally that is a host repository the serve target mounts; in the cloud, a remote.
  - The remote's token is a declared secret. The git kind takes it out of the task's environment and gives it to git alone, so it is absent from the agent's environment. The task process's initial environment, readable under `/proc` to an unfenced shell, still holds it, as it holds every secret; that is recorded under §ODO005.
- **A target seeds a host repository from its remote.** `seed-repository`, on every agentic and workflow project, bare-clones a declared repository's `https://` remote into a host location, `.agentforge/repositories/<name>.git` in the workspace by default, kept out of version control. It declares that location for every project's local serving, in the workspace root's env files. It adopts a bare clone made by hand, optionally points a reading clone at it, and never writes to the remote. It uses the host's own git credentials and refuses a URL carrying any. Serve still creates an empty host repository, but only for a repository with no remote, and it names the target when it does. StrategyFoundry seeds its strategies repository this way instead of by hand.
- **The AgentForge image installs `git`.**

## Requirements

- **Amends §REQ403** in place (operator, 2026-10-24: alpha, no live consumer). The new text: "Nothing carries from one invocation to the next except state the consumer declared durable, and a declared filesystem's local copy, which carries to later invocations of the same runtime session while its container lives unless the procedure removes it; nothing an invocation started outlives it." That is the kept copy's requirement; no separate id is added.
- Serves §REQ401: the consumer's identifiers. The runtime session decides whether a local copy carries.
- Serves §REQ603: no credential in anything AgentForge emits.
- Serves §REQ701: one code path. A local host repository and a remote are the same kind, chosen by the environment.
- Serves §REQ306: refuse, never queue. A mount's claim is unchanged.
- **New, §REQ715**: "A consumer develops locally against a host copy of a declared repository's history, seeded from its remote without writing to it, and shared by every project in its workspace."
- **New, §REQ405**: "A procedure's durable files may live in a version-controlled repository, so each change it persists is recorded with its history and author, and two writers' changes to one file are refused, never silently overwritten."
- Leaves unmet: the credential broker and token rotation (§ODO005). A git write token is a key with access beyond inference, which is §ODO005's trigger. Because the token is absent from the agent's environment and its remaining exposure is the `/proc` one every secret has, the operator deferred §ODO005 again on 2026-10-24 (recorded in `DESIGN_OPTIONS.md`). Rotation stays manual.

## Design options

- §ODO005 (credential broker) is touched and stays open, deferred again, as above.
- No other open option is resolved.

## Interfaces

- **The `Filesystem` contract** (`/agent`):
  - A shared option declares removal of the local copy.
  - `Permission` gains the `delete` action.
  - `MountedFilesystem` gains an optional push the agent may call.
  - A new kind, `GitFilesystem`.

  These are where a filesystem's behaviour is declared and given to the handler (ADR 0015).
- **The framework's derived run options**: a push tool for each mount that offers one. The framework is what renders mounts into a run (ADR 0021).
- **A deployment's declaration** of repositories, beside its buckets: the serve target's environment and `AgentRuntime`. That is where a store is mapped to a deployment.
- **The AgentForge image**: `git`.
- **The vended `seed-repository` target** on agentic and workflow projects: how a consumer seeds a host repository. Generated targets are the plugin's interface (ADR 0010).

## Capabilities

### New Capabilities

- `filesystem-git`: a filesystem whose store is a branch of a git repository. It covers how it mounts, pushes, merges, refuses a conflict, deletes, authenticates, and offers the agent a push.

### Modified Capabilities

- `filesystem-lifecycle`:
  - Unmount keeps the local copy unless removal is declared, and the next mount of the same store reuses it within its runtime session.
  - Deletes enabled add a `delete` permission.
- `harness-framework`: the derived run options include a push tool for a mount that offers one, and render nothing for `delete`.
- `infra-agent-runtime`: a deployment names its repositories, and maps a repository's token as a secret that is not required.
- `plugin-agentic-agent`: serving an agent provides its declared repositories, creating a missing host repository for a repository with no remote.
- `plugin-agentic-project`: a target seeds a host repository from its remote, for every project of the workspace.
- `plugin-workflow-project`: the same target, and the same declared repositories in the workflow project's local run.

## Non-goals

- Branches per task, procedure or agent; pull requests; merging branches. Everything is on one branch.
- Timer checkpoints for git.
- Git LFS, submodules, signed commits, SSH remotes.
- Syncing a host repository with its remote, or a host repository per environment.
- A credential broker or automatic token rotation (§ODO005).
- An end-to-end run against a hosted remote on AgentCore. It waits for StrategyFoundry's first deploy; local e2e and `integ` use a repository on disk.
- A delete tool for the agent.
- Changing the S3 kind's sync engine or its delete semantics, beyond the `delete` permission.

## Impact

- The harness's filesystems (base lifecycle, S3 and scratch kinds, a new git kind) and both frameworks' derived run options.
- `/agent` exports; the core declaration of repositories.
- The Nx plugin's serve executor (bind-mounting a local repository), a new `seed-repository` executor vended on agentic and workflow projects, and `AgentRuntime` (`repositories`).
- The AgentForge image's `Dockerfile` (`git`).
- Docs:
  - `docs/ARCHITECTURE.md`.
  - `docs/REQUIREMENTS.md`: §REQ405, and §REQ403 amended.
  - `docs/DESIGN_OPTIONS.md`: §ODO005's dated deferral.
  - ADR 0011, mutated in place: filesystems persist by syncing to a store, not only an object store.
  - `docs/ROADMAP.md` (StrategyFoundry's store, "git later"), the root `README.md` (files within a session, `context.agentOptions`, `.env.serve`), and `docs/GLOSSARY.md` (Filesystem, Agent options).
  - ADR 0015, mutated in place for kept copies and the `delete` permission.
  - New ADR 0024, proposed.
  - `docs/research/` (git and `s7cmd` behaviour relied on).
- The AgentForge plugin's skill (Generate and operating references) and `references/migrations.md` (the unmount default, `seed-repository`).
- `packages/examples/smoke-coverage`: a procedure on a git filesystem, with local e2e. Its existing store round trips read from another runtime session, since a kept copy would otherwise answer them. `integ/local/filesystem-git` and `integ/local/seed-repository`.
