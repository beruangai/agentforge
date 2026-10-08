# Design

## Context

See proposal.md — Why. What holds today ([filesystem-lifecycle](../../specs/filesystem-lifecycle/spec.md), [ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md)):

- **Options.** `FilesystemOptions.localPath` is optional and absolute. A kind supplies `defaultLocalPath({ taskId, name })` when the consumer gives none: `ScratchFilesystem` does (`<tmpdir>/agentforge-scratch/<taskId>/<name>`), and `S3Filesystem` requires one.
- **Scope.** `scope(request)` returns `{ remotePath, read?, write? }`. `#resolve` refuses an absolute or climbing `remotePath` and builds a `Mount { name, taskId, localPath, remotePath, read, write }`. The kinds read only `mount.localPath` and `mount.remotePath`: `S3Filesystem` syncs `s3://<bucket>/<remotePath>/` with `<localPath>/`.
- **Lifecycle.** `mount()` makes the directory, pulls, and on a failed pull removes it. `unmount()` pushes as declared, then always removes `mount.localPath`.
- **Overlap.** `registry.ts` refuses two filesystems of one procedure whose `localPathFor({ taskId, name })` overlap. That check runs before any scope is resolved.
- **Concurrency.** Each task is its own process, and a container admits up to `AGENTFORGE_ADMISSION_LIMIT` (4) at once. Nothing coordinates their mounts.

## Goals / Non-Goals

**Goals:**
- The local directory follows the scope, so different subpaths never share one.
- Two live tasks never share or nest a local directory in one container; the second fails loudly and retryably.
- One shared options object declares a filesystem family once.

**Non-Goals:**
- Changing how a kind pulls or pushes.
- Remote coordination across containers.

## Decisions

### Roots on the filesystem, the subpath from the scope

```ts
export interface FilesystemOptions {
  /** The local directory its mounts live under, absolute; a kind sets a default or requires it. */
  readonly localRoot?: string;
  /** The store's partition its mounts live under, absolute within the store; `/`, the whole store, when absent. */
  readonly remoteRoot?: string;
  readonly scope: (request: FilesystemRequest) => FilesystemScope;
  readonly pushOn?: readonly PushOnState[];
  readonly checkpoints?: { readonly intervalSeconds: number; readonly settleSeconds: number };
}

export interface FilesystemScope {
  /** Relative to both roots: the mount is `<localRoot>/<subpath>` here and `<remoteRoot>/<subpath>` in the store; `''` for the whole root. */
  readonly subpath: string;
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}

export interface S3FilesystemOptions extends FilesystemOptions {
  /** Required: an S3 filesystem has no default local root. */
  readonly localRoot: string;
  readonly bucket: string;
  readonly dangerouslyEnableDeletes?: boolean;
  readonly exclude?: readonly string[];
}
```

`Mount` keeps `localPath` and `remotePath`, now resolved: `join(localRoot, subpath)` and `posix.join(remoteRoot, subpath)`, with trailing slashes trimmed, so `remotePath` is absolute within the store (`/` for all of it). A kind maps it to its store's own addressing: `S3Filesystem` drops the leading slash to form the key prefix, since an S3 key has none. A key that itself begins with `/` is therefore out of a filesystem's reach. So `S3Filesystem.pull` and `push` and the `MountedFilesystem` the handler gets are unchanged. Both roots must be absolute, and `subpath` relative; none may have a `.` or `..` segment. The roots are checked at construction, the subpath at resolve. *Why the remote root is absolute:* a root is a position from the top of its store, as the local root is from the top of the filesystem; only the S3 key encoding has no leading slash, and that is the kind's to apply.

A kind's default becomes `defaultLocalRoot({ name })`. It no longer takes the task, because the task's part of the path is now the subpath.

Shared defaults are a plain object, which is the pattern ARCHITECTURE §3 already names:

```ts
const MEMORIES = {
  bucket: 'memories',
  localRoot: '/workspace/memories',
  remoteRoot: '/projects/alpha',
  pushOn: ['TASK_STATE_COMPLETED'],
} as const satisfies Omit<S3FilesystemOptions, 'scope'>;

filesystems({
  memory: new S3Filesystem({
    ...MEMORIES,
    scope: ({ input }) => ({ subpath: `spaces/${SpaceInputSchema.parse(input).space}` }),
  }),
});
```

*Alternatives:*
- **A per-task local directory, `<localRoot>/<taskId>`.** It isolates even two tasks on one subpath, but every path the agent sees changes from task to task. A memory index, a prompt or a resumed transcript that names a file would point at a directory that is gone. Mirroring the subpath keeps paths stable, and the one-live-task rule below covers the same-subpath case loudly.
- **A factory or `S3Filesystem.base()`.** Once roots and subpath compose by themselves, a base is just the options without `scope`, and spreading it is the whole mechanism. A builder would be a second way to construct the same object.
- **Keep the name `remotePath`.** The path is shared by both sides, so `subpath` says what it is.

### `ScratchFilesystem`: the subpath is the task id

```ts
export class ScratchFilesystem extends Filesystem {
  constructor(options?: { readonly localRoot?: string });
}
```

Its scope is `({ context }) => ({ subpath: context.taskId, write: ['**'] })`, and its default root is `<tmpdir>/agentforge-scratch/<name>`. The default mount moves from `<tmpdir>/agentforge-scratch/<taskId>/<name>` to `<tmpdir>/agentforge-scratch/<name>/<taskId>`. A named root holds a directory per task.

### One live task per local directory: a container-wide claim registry

Task processes share nothing but the container's filesystem, so the registry lives there: `<tmpdir>/agentforge-mounts/`, one JSON file per live mount, `<taskId>.<name>.<pid>.json`, holding `{ localPath, taskId, name, pid }`. The pid in the name keeps a crashed attempt's leftover entry from blocking a retry of the same task in the same container.

`claimLocalDirectory(mount)` runs in `mount()`, **before** the directory is created or pulled:

1. Write the task's own entry, renamed into place so a concurrent lister never reads it half-written.
2. List every entry. An entry whose `pid` is not alive (`process.kill(pid, 0)` throws `ESRCH`) is stale: remove it and skip it.
3. If any other live entry's `localPath` equals, contains or is inside this one, remove the task's own entry and throw `FilesystemUnsynced`, naming the directory and the holding task. The lifecycle turns that into `FILESYSTEM_UNSYNCED`, which is retryable. Nothing is created or removed, so the holder's files are untouched.

The release runs in `unmount()`'s `finally`, after the directory is removed, and also when a pull fails.

**Why claim-then-check needs no lock.** Each of two racing claims writes its entry before it lists. The later lister always sees the earlier entry, so the two can never both succeed. At worst both refuse, retryably. An exclusive mutex, or a lock library with stale-lock recovery, would buy nothing over this.

**The per-procedure check moves after resolution.** `registry.ts` compares the resolved `localPath`s of one task's filesystems once every scope has resolved, still before anything is mounted, and still fails `EXECUTION_ERROR`. That is a defect in the procedure, not contention.

*Alternatives:*
- **Reference-counted sharing.** A second task on the same directory joins it, and the last one out removes it. Each task still pulls over the other's work in progress, and pushes what the other wrote. Sharing a live directory is the bug, not something to support.
- **Coordinating in the runtime's executor.** The runtime knows which tasks are live, but not their mounts, and must not import the harness ([ADR 0001](../../../adr/0001-four-layers-with-contracts-at-the-boundaries.md)).

### ADR 0015, mutated in place

ADR 0015 changes in three places:
- **Its scope bullet:** `subpath` under `localRoot` and `remoteRoot`.
- **"A kind decides its `localPath`":** becomes `localRoot`, and a scratch root holds a directory per task.
- **"Two tasks on one path or prefix are the consumer's":** narrows to the prefix; the local directory is now AgentForge's, refused when shared.

No consumer depends on it yet, so it is mutated in place. The commit says what changed.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| `remoteRoot` not absolute, or with a `.` or `..` segment | construction | throws, so the procedure module fails to load |
| `localRoot` not absolute | construction | throws, as `localPath` does today |
| `subpath` absolute, or with a `.` or `..` segment | resolve, before any mount | `EXECUTION_ERROR`, naming the subpath |
| Two filesystems of one procedure resolve overlapping directories | after resolution, before any mount | `EXECUTION_ERROR`, naming both |
| Another live task in the container holds the directory, or one around or inside it | `mount()`, before anything is created | `FILESYSTEM_UNSYNCED`, retryable, naming the directory and the task |
| `dangerouslyEnableDeletes` with `remoteRoot` joined to `subpath` resolving to `/` | `validate`, before any mount | `EXECUTION_ERROR` |
| The claim registry cannot be written or read | `mount()` | `FILESYSTEM_UNSYNCED`, retryable, carrying the error |

## What earns which test

- **Unit:**
  - **Resolution:** the roots and subpath compose, with no remote root, and with an empty subpath; refusals for each malformed root or subpath.
  - **Scratch:** a mount per task under a named root.
  - **The per-procedure overlap check** on resolved paths.
  - **The claim registry,** against a temporary registry directory. An overlapping claim by a live process is refused; a child process stands in for another task, so its pid is real. A stale claim, from a pid that has exited, is cleared. Release frees the directory. A refused claim leaves the holder's directory untouched.
  - **Two claims racing:** never both granted.
- **Integration (`integ/aws/filesystem-s3-sync/`):** already drives `s7cmd` against a real bucket. It moves to `localRoot` and `subpath` and gains one case with a `remoteRoot`, which proves the joined prefix is what is synced.
- **e2e on AgentCore (`smoke-coverage`):**
  - two `KeepNote` tasks on different topics, started together in one runtime session, both keep their note, and `RecallNote` returns each topic's own;
  - two on the same topic started together: one completes and the other fails `FILESYSTEM_UNSYNCED`, retryable.

  This is the bug as a consumer would meet it, so it is dogfooded where it happens.
- **Settled once:** nothing new about the platform. Process liveness through signal 0 is POSIX.

## Risks / Trade-offs

- [A task process killed without unmounting leaves its claim, and its pid is later reused by a live process, so the directory is refused in that container until it ends] → Unmount runs on completion, failure, cancel and timeout; only a crash or `SIGKILL` orphans a claim, and pid reuse inside a container's lifetime is rare. The refusal is retryable, names the holding task, and the container is replaceable. Accepted, not engineered around.
- [Two racing claims on one directory both refuse] → Retryable, and it only happens when two tasks start on the same subpath at the same instant, which is the contention being refused anyway.
- [**BREAKING** option names] → No consumer is live. The examples and the integ test move in this change.
- [The default scratch path changes shape] → Nothing names it; prompts take it from `context.filesystems.<name>.localPath`.

## Migration Plan

A consumer changes `localPath:` to `localRoot:` on an `S3Filesystem`, and `remotePath:` to `subpath:` in its scope. A path it named as a constant is taken from `context.filesystems.<name>.localPath` or `.path(...)` instead. There is nothing to roll back in data: the remote layout is the same prefix, `remoteRoot` joined to `subpath`.
