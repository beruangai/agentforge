# Tasks

Groups 1–2 come first. Groups 3 and 4 depend on 1 and can run in parallel with each other. Group 5 depends on 3; group 6 on 3–5; group 7 on everything.

## 1. Base lifecycle: kept copies and the `delete` permission

- [ ] 1.1 Add `removeLocalCopy` to the shared options (strict schema). Add `request` to `Mount`. Add the kind's `deletes` flag, and the `storeIdentity`, `privatePaths` and `agentPush` hooks, to `Filesystem`.
- [ ] 1.2 Kept-copy markers beside the claims: the identity (local directory, kind, `storeIdentity`, remote path, runtime session) and the `paths` to remove (`privatePaths`). At mount, remove every listed path of each marker at, around or inside the directory that does not match in full, then write this task's marker. Unmount with `removeLocalCopy`, and a failed pull, remove the copy and its marker. At unmount, remove the copy only with `removeLocalCopy`, and release the claim either way. A failed pull keeps the copy.
- [ ] 1.3 `ScratchFilesystem` always removes; `S3Filesystem` passes `deletes` from `dangerouslyEnableDeletes`.
- [ ] 1.4 `PermissionAction` gains `delete`; baseline permissions add `delete` per write glob when the kind deletes.
- [ ] 1.5 `MountLifecycle`'s queue takes any push thunk. `MountedFilesystem.push` is present when the kind has `agentPush` and `pushOn` includes `TASK_STATE_FAILED`.
- [ ] 1.6 Unit tests for 1.1–1.5: keep, remove, another session, another store, a nested copy, scratch, a failed pull, delete permissions, an offered push queued with unmount's.

## 2. Repository declaration

- [ ] 2.1 `FILESYSTEM_REPOSITORIES_VARIABLE` in `core/filesystem.ts`, and one `parseDeclared(variable, value)` replacing `parseDeclaredBuckets` for both, with tests.
- [ ] 2.2 `AgentRuntime` takes `repositories` and names them to the harness. Construct test.
- [ ] 2.3 The serve executor maps each repository. A path location: create a bare repository if it is absent (`uploadpack.allowFilter`), bind-mount it at `/mnt/agentforge-repositories/<name>`, and pass `file://`. A URL location passes as it is. Executor tests.

## 3. `GitFilesystem`

- [ ] 3.1 One child runner (`runChild`) shared with `s7cmd`: async spawn with no shell, an optional bound, a per-child environment, a redacted stderr tail, a missing-binary message. The git runner on it: a 300 s bound; extraheader, `safe.directory`, no ambient config, no prompt; redaction before the task log and causes.
- [ ] 3.2 Options, construction and `validate`:
  - removing the token from the environment at construction;
  - refusing `checkpoints` and an invalid branch;
  - refusing a repository name outside `FILESYSTEM_NAME_PATTERN`, an undeclared repository, an unsupported scheme, userinfo, https without a token, and deletes at `/`.
- [ ] 3.3 `pull`:
  - first mount: atomic blobless clone, base ref, subtree read into the mount, an empty path or branch mounts empty;
  - an empty branch: no base, so the first push is a root commit;
  - kept copy: stale locks removed, `advanceTo(tip)` keeping local changes the store did not make and logging each one discarded.
- [ ] 3.4 `push`, recording: change selection by write globs, `exclude` and deletes; splice and commit with message, author and trailers; a root commit on an empty branch.
- [ ] 3.5 `push`, publishing: refusal on a shared file, `merge-tree` onto the tip, bounded jittered retry, `CREDENTIAL_EXPIRED` for a refused token, then `advanceTo` with the pushed files recorded first.
- [ ] 3.6 `agentPush`, `storeIdentity` and `privatePaths`; a pull over an unmoved tip restores deleted tracked files.
- [ ] 3.7 Unit tests over a scripted runner: validation errors, redaction, change selection, retry and credential classification.
- [ ] 3.8 Export `GitFilesystem` and `PushReport` from `/agent`.

## 4. Frameworks

- [ ] 4.1 `claude`: render `read` and `edit` only, with a test that `delete` renders nothing; an `agentforge` SDK MCP server (`alwaysLoad`) with `push_<name>` per offering mount, allowed, refusing a full tool name over 64 characters. Tests.
- [ ] 4.2 `claude`: a factory registry for the server, and the kernel's replacement of a still-connected instance, so concurrent runs each get their own. Record SDK 0.3.280's per-query connect and close in `docs/research/claude-agent-sdk.md`. Tests.
- [ ] 4.3 `strands`: a `push_<name>` tool per offering mount, refusing a name over 64 characters; `delete` renders nothing. Tests.

## 5. Image and integration

- [ ] 5.1 `git` in the AgentForge image's `Dockerfile`; the pinned-base-image integ still passes.
- [ ] 5.2 `integ/local/filesystem-git`, covering the scenarios in design § Tests. The no-token case probes a `node:child_process` child. Record the Bun spawn finding in `docs/research/git-filesystem.md`.
- [ ] 5.3 `integ/aws/filesystem-s3-sync`: a pull over a kept copy keeps a newer local edit, takes a newer store object, restores a missing file, and does not take a store deletion. Then update the research note's "to be verified".

## 6. Example (dogfood)

- [ ] 6.1 `smoke-coverage`'s hello-agent: a procedure on a git filesystem pushing on `TASK_STATE_FAILED`, whose agent writes in and outside the write scope and calls its push tool, with its repository in `.env.serve`.
- [ ] 6.2 Local e2e: the host repository has the agent's commit with its message and trailers; the second task in the same session finds the first's file outside the write scope.
- [ ] 6.3 `smoke-coverage`'s S3 note and memory round trips read back in another runtime session. Re-run every example's local e2e (`golden-kata`, `smoke-coverage`, `strands-smoke`, `research-brief`).

## 7. Documents and guidance

- [ ] 7.1 `docs/ARCHITECTURE.md`: Filesystems (kept copies, `delete`, the git kind, the claim released at unmount), the `/agent` and `/infra` surfaces, serve's repositories. `docs/ROADMAP.md`: StrategyFoundry's store and "git later". The root `README.md`: files within a session, `context.agentOptions`, `.env.serve`.
- [ ] 7.2 `docs/REQUIREMENTS.md`: §REQ405, and §REQ403 amended in place. The Numbering rule gains the ADRs' exception — until a consumer depends on it, a requirement's meaning may be corrected in place by the operator — and §REQ403 notes its amendment. `docs/GLOSSARY.md`: the Filesystem entry (the git kind, `delete`, the kept local copy, the agent push) and the Agent options entry (the push tool).
- [ ] 7.3 `claude-plugin/skills/agentforge/` skill: declaring a git filesystem at module scope, its token as an unrequired secret, `removeLocalCopy`, the agent push, the S3 kept copy with deletes, and spawning with an explicit environment. `references/migrations.md`: the unmount default.
- [ ] 7.4 `.claude/rules/testing.md`: `git` ≥ 2.40 on the `PATH` for `integ` `local` and serve.
