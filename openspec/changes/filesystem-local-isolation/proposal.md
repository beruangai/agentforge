# Proposal

## Why

A filesystem's local directory is static: an `S3Filesystem` mounts at the `localPath` it was constructed with, whatever its scope resolves for the task. A container runs up to four tasks at once. Two live tasks of one procedure therefore share one local directory even when their scopes name different prefixes:

- their pulls mix in it;
- the first to unmount removes the other's files mid-run;
- a push sends the other task's files into its own prefix.

Nothing fails. This is silent cross-prefix contamination, today on the notebook and next on memory. The consumer cannot prevent it either, because it cannot make the local directory follow the scope. ADR 0015 left "two tasks on one path or prefix" to the consumer. The prefix is the consumer's, since sharing it is the point. The local directory is an artifact of AgentForge's own lifecycle, so keeping it to one task is a mechanical invariant and AgentForge's to enforce. The terms are also unclear: `remotePath` names a path relative to the bucket that lands at the root of `localPath`, and nothing says so.

## What Changes

- **Roots and a subpath.**
  - A filesystem declares a **local root** (`localRoot`, absolute) and optionally a **remote root** (`remoteRoot`, absolute within the store, `/` by default). The remote root is a static partition of the store, such as one bucket shared across projects and agents.
  - Per request, its scope resolves a **subpath** (`subpath`), relative to both roots.
  - The mount is the store's `<remoteRoot>/<subpath>` at `<localRoot>/<subpath>`. Only that subtree is pulled and pushed.
  - **BREAKING:** `S3Filesystem`'s `localPath` option becomes `localRoot`, and a scope's `remotePath` becomes `subpath`. `context.filesystems.<name>.localPath` keeps its name: it is the resolved mount.
- **A local mount belongs to one live task.**
  - A task that would mount a directory another live task in the same container holds, or one nested in or around it, fails before its handler runs. The cause is `FILESYSTEM_UNSYNCED`, which is retryable, and names the directory and the holding task. Nothing of the holding task is touched.
  - A mount is released when it is unmounted, or when its task's process has ended.
- **Shared defaults are a plain options object.** A higher layer declares `bucket`, `localRoot`, `remoteRoot` and `pushOn` once, and each procedure spreads it with its own `scope`. There is no factory or builder, since roots and subpath compose by themselves.
- **`ScratchFilesystem`'s subpath is the task id.**
  - Its default root is a directory of its name under the system's temporary directory.
  - A `localRoot` the consumer names holds one directory per task instead of being shared.
- **`dangerouslyEnableDeletes`** needs a resolved remote path other than `/`: remote root and subpath together.
- **Records.** ADR 0015 is mutated in place: no consumer depends on it. The README's note on keeping paths to one task is rewritten: the local directory is now AgentForge's, and the prefix stays the consumer's. ARCHITECTURE §2 lists the new invariant.
- **Examples:** `smoke-coverage`'s notebook moves to `localRoot` and `subpath`, and its prompts take the note's path from the mount.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `filesystem-lifecycle`:
  - a mount is its subpath under the filesystem's local and remote roots;
  - a local mount belongs to one live task in a container;
  - a kind decides its local root, not its path, and a scratch root holds a directory per task.

## Impact

- **Interface:**
  - `FilesystemOptions` gains `localRoot` and `remoteRoot` in place of `localPath`;
  - `FilesystemScope.remotePath` becomes `subpath`;
  - `Mount` carries the resolved `localPath` and `remotePath`, so kinds read what they read today.

  The options belong on the filesystem because a filesystem is where the consumer declares where its files live. The kinds' `pull` and `push` are unchanged.
- **Harness:**
  - the mount resolves paths from roots and subpath;
  - a container-wide registry of live local mounts refuses an overlapping one;
  - the per-procedure overlap check runs on resolved paths, after scopes are resolved.
- **No change** to the A2A contract, the task protocol, the cause codes, the runtime or the infrastructure constructs.
- **Requirements:**
  - §REQ401: the consumer chooses its roots and subpath, and AgentForge imposes no mapping beyond composing them;
  - §REQ403: one task's local files never carry into another's.
- **Open options:** none depended on.
- **Follows:** `auto-memory` is revised on top of this. A memory space is a subpath under a memories root.

## Non-goals

- Coordinating two tasks on one remote prefix across containers. That stays the consumer's: a continuity key per prefix, or a subpath per task.
- Sharing a live local directory between tasks, reference-counted. A second task on the same directory is refused, not admitted.
- A builder, factory or `base()` for filesystem defaults.
