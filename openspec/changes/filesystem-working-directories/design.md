# Design

Guidance, not prescription: adapt to actual constraints.

## Context

See proposal.md for why. `f489b71` built the API, the construct, the outcome integration and a `hello-agent` e2e on a hand-rolled S3 engine (list, MD5 against ETag, put, delete, relist). This design keeps everything above the engine and replaces the engine with `s7cmd`.

## Public API

```ts
// @beruangai/agentforge/agent
interface WorkingDirectorySync {
  pull: boolean;
  push: 'NEVER' | 'WHEN_COMPLETED' | 'WHEN_ENDED';
  continuous: false | { everySeconds: number; quietSeconds: number }; // only with WHEN_ENDED
  deletes: boolean;                                                    // only with pull, on a non-empty prefix
  exclude: readonly string[];                                          // regular expressions
}
interface WorkingDirectorySpec { name: string; prefix: string; sync: WorkingDirectorySync }
TaskContext.openWorkingDirectory(spec: WorkingDirectorySpec): Promise<{ path: string }>

// @beruangai/agentforge/infra
class WorkingDirectory extends Construct { readonly bucket: Bucket }
AgentRuntimeProps.workingDirectories?: Record<string, WorkingDirectory>
```

## Decisions

- **`s7cmd sync`, run as a child of the task process.** A cancel or a lost container takes it with the task.
  - **Pull:** `sync s3://bucket/prefix/ <dir>/`.
  - **Push:** `sync <dir>/ s3://bucket/prefix/ --check-etag`, plus `--delete` when `deletes` is set.
  - **Continuous push:** also passes `--filter-mtime-before <now − quietSeconds>`, so a file being written is left for the next pass. The final push has no such filter.
  - **Exclusions:** `exclude` is joined into one `--filter-exclude-regex`. Under `--delete`, that filter also protects an excluded object from deletion.
  - The alternative, the hand-rolled engine, is rejected: it re-implements what `s7cmd` already verifies, and it went against A0's recorded choice.
- **Verification is `s7cmd`'s.** It checks each transferred object's ETag. Its exit codes are documented: 0 success, 1 error, 2 bad arguments, 3 warning (for example an ETag mismatch), 101 panic, 130 interrupted.
  - Any exit other than 0 means unsynced, and its stderr tail becomes the cause's message.
  - The hand-rolled relist is removed rather than kept as a second check.
- **Credentials:** the AWS SDK for Rust's default chain, the same role the server uses. The AgentCore e2e proves it works inside the microVM.
- **Pinning:** the Dockerfile uses `ADD --checksum=sha256:…` on the release's musl aarch64 archive. A new release is admitted by bumping the version and the sha256, then re-running `integ/aws/filesystem-s3-sync`.
- **Errors → outcomes:**

  | Failure | Outcome |
  |---|---|
  | Pull fails | the task fails, `WORKING_DIRECTORY_UNSYNCED` |
  | Push fails on a completed task | `FAILED`, `WORKING_DIRECTORY_UNSYNCED` |
  | Push fails on a failed task | the original cause, with the sync's failure appended to its message |
  | Continuous push fails | logged; the final push decides |
  | Invalid declaration, undeclared name, or a second open of the same name | `EXECUTION_ERROR` (a programming error) |

- **Tests:**
  - Unit tests cover the declaration's validation, the arguments passed to `s7cmd`, and the mapping from exit code to outcome, against a scripted runner.
  - `integ/aws/filesystem-s3-sync` runs the pinned binary in the base image as built, against a scratch bucket. It covers pull, push, `--check-etag`, `--delete` with exclusion protection, the quiet-period filter, and exit codes. It earns its place because the pin can drift.
  - The `hello-agent` AgentCore e2e keeps a note in one container and reads it back in another.

## Risks / Trade-offs

- [`s7cmd` is a personal project; the engines are pinned but maintained best-effort] → pin by sha256, and admit each release through the integ test.
- [Whether exclusion regexes match the object key or the relative path on a pull] → the integ test pins the behaviour; the spec promises only relative-path matching.
- [A KMS-encrypted bucket breaks ETag verification] → the construct fixes encryption to S3-managed, and checkov's KMS rule is skipped in config.
