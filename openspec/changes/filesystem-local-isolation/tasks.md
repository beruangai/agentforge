# Tasks

Group 1 changes how a mount resolves its paths. Group 2 adds the claim registry and needs group 1. Group 3 moves the examples and the integ test onto the new options and needs group 1. Group 4 dogfoods both on AgentCore. Group 5 closes the records.

## 1. Roots and subpath

- [x] 1.1 `FilesystemOptions.localRoot` and `remoteRoot`, `FilesystemScope.subpath`, `S3FilesystemOptions.localRoot` (required). `Mount.localPath` and `remotePath` are resolved from the roots and the subpath. A kind's default is `defaultLocalRoot({ name })`. `S3Filesystem`'s delete guard is on the resolved remote path. Verified by unit tests, `nx run @beruangai/agentforge:test`:
  - roots and subpath compose: with and without a remote root, and with an empty subpath; the S3 key prefix drops the remote path's leading slash;
  - a malformed root throws at construction;
  - a malformed subpath fails `EXECUTION_ERROR` before anything is mounted;
  - the baseline permissions and `path()` are rooted at the resolved mount;
  - deletes are refused when the resolved remote path is `/`.
- [ ] 1.2 `ScratchFilesystem({ localRoot? })` with the task id as its subpath, under a default root of `<tmpdir>/agentforge-scratch/<name>`. The per-procedure overlap check in `registry.ts` compares resolved local paths after every scope resolves, still before anything is mounted. Verified by unit tests: two tasks under one named scratch root mount separate directories, and two filesystems of one procedure resolving overlapping directories fail `EXECUTION_ERROR`, naming both.

## 2. One live task per local directory

- [ ] 2.1 The container-wide claim registry (`<tmpdir>/agentforge-mounts/`, an injectable directory for tests). A claim is taken in `mount()` before the directory is created; refused, it throws `FilesystemUnsynced` naming the directory and the holding task. It is released after unmount's removal and on a failed pull. Stale claims, whose pid is dead, are cleared. Verified by unit tests:
  - an overlapping claim held by a live child process is refused with `FILESYSTEM_UNSYNCED`, retryable, and the holder's directory is untouched;
  - a directory inside or around a held one is refused;
  - a claim from an exited pid is cleared and the mount succeeds;
  - a released claim frees the directory;
  - two claims written before either lists never both succeed.

## 3. Examples and integration

- [ ] 3.1 `integ/aws/filesystem-s3-sync/` moves to `localRoot` and `subpath` and gains a case with a `remoteRoot`, asserting that the objects land under the joined prefix. Verified by `nx run @beruangai/agentforge:integ --configuration=aws -- integ/aws/filesystem-s3-sync`.
- [ ] 3.2 `smoke-coverage`'s notebook: `localRoot: '/workspace/notebook'`, `subpath: topics/<topic>`. Its prompts name the note's file through `context.filesystems.notebook.path('note.md')`, and `KeepNote` reads it back the same way. Verified by `nx run @beruangai/smoke-coverage:typecheck` and `nx run @beruangai/smoke-coverage:e2e`.

## 4. Dogfood on AgentCore

- [ ] 4.1 The `smoke-coverage` AgentCore suite gains two tests. Verified by `nx run @beruangai/smoke-coverage:e2e-agentcore` after its deploy:
  - two `KeepNote` tasks on different topics, started together in one runtime session: both keep their note, and `RecallNote` returns each topic's own;
  - two on the same topic, started together in one runtime session: one completes, and the other ends `TASK_STATE_FAILED` with cause `FILESYSTEM_UNSYNCED`, retryable.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **ADR 0015, mutated in place:**
    - the scope bullet becomes `subpath` under `localRoot` and `remoteRoot`;
    - "A kind decides its `localPath`" becomes `localRoot`, with a scratch root holding a directory per task;
    - the consumer's share narrows to the prefix, and the local directory is AgentForge's, refused when shared.
  - **ARCHITECTURE:**
    - §3's filesystems paragraph: roots, subpath, the shared-options pattern and the claim;
    - §2's mechanical invariants: one live task per local mount directory in a container.
  - **The root README's filesystem notes:** the local directory is AgentForge's, and the prefix stays the consumer's, through a continuity key or a subpath per task. `remotePath` becomes `remoteRoot` joined with `subpath` in the deletes note.
  - **GLOSSARY:** local root, remote root, subpath.
