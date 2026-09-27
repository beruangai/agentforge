# Design

Guidance, not prescription: adapt to actual constraints.

## Context

See proposal.md for why. The `s7cmd` engine, the sync declaration and its refusals, the outcome waiting for the push, the bucket construct, `integ/aws/filesystem-s3-sync` and `hello-agent`'s notebook e2e are already built and verified. They move under the Filesystem abstraction.

## Public API

```ts
// @beruangai/agentforge/agent
type TaskEnding = 'COMPLETED' | 'FAILED' | 'CANCELED';
interface FilesystemRequest { input: unknown; context: TaskContext }
interface FilesystemScope {
  root: string;              // the subtree mounted (an S3 prefix, a repo path…); '' for all of it
  read?: readonly string[];  // globs relative to the mount; default ['**']
  write?: readonly string[]; // globs relative to the mount; default ['**'] for READ_WRITE, [] for READ_ONLY
}
interface FilesystemOptions {
  path?: string;             // where it mounts; each kind sets a default or requires it
  access: 'READ_ONLY' | 'READ_WRITE';
  scope: (request: FilesystemRequest) => FilesystemScope;
  push: 'NEVER' | 'WHEN_COMPLETED' | 'WHEN_ENDED';
  checkpoints: false | { intervalSeconds: number; settleSeconds: number }; // only with WHEN_ENDED; pushes only files unchanged for settleSeconds
}
abstract class Filesystem {
  protected abstract pull(mount: Mount): Promise<void>;
  protected abstract push(mount: Mount, options: { modifiedBefore?: Date }): Promise<void>;
  // run by the base class from its options:
  //   mount:   resolve scope and path → create → pull (always) → start checkpoints
  //   unmount: stop checkpoints → push (per `push` and the ending) → remove the local copy
}
class S3Filesystem extends Filesystem {}      // + bucket (a name the construct declared), exclude, dangerouslyEnableDeletes (default false); path required
class ScratchFilesystem extends Filesystem {} // pulls nothing, never pushes; path defaults to a directory of the task's own

function filesystems(entries: Record<string, Filesystem>, options?: { inherit?: boolean }): Middleware;

interface MountedFilesystem {
  path: string;
  permissions: { allow: string[] }; // Read(//path/<read>) and Edit(//path/<write>)
}
TaskContext.filesystems: Readonly<Record<string, MountedFilesystem>>
TaskContext.filesystemPermissions: { allow: string[] } // every mount's, merged

// @beruangai/agentforge/infra
class S3FilesystemBucket extends Construct { readonly bucket: Bucket }
AgentRuntimeProps.filesystems?: Record<string, S3FilesystemBucket>
```

## Decisions

- **Registration and lifecycle are separate.**
  - `filesystems()` only merges its entries into the registry on the context. By default it appends, replacing any entry with the same name. With `inherit: false` it starts from an empty registry.
  - The harness appends one lifecycle middleware to the procedure at call time. oRPC's `.use()` on a built procedure appends it last, so it runs innermost: after every registration and before the handler. It mounts the final registry.
  - `executeProcedure` unmounts once the outcome is known, so an output that fails validation counts as a failure.
  - Alternative rejected: mounting inside each registration middleware. A procedure's override would come after the house default had already been pulled.
- **Every mount pulls.** A task works from what is in the store, never blind, and a delete is always relative to what was pulled. A procedure that only adds a file scopes its `root` to it, where a pull costs one listing. Pulling again mid-task is an operation for later, not an option.
- **Operations, not options, are the abstraction.** A kind implements `pull` and `push`; checkpoints are `push({ modifiedBefore })` on a timer run by the base class. Kind-specific config such as `dangerouslyEnableDeletes` and `exclude` stays on the subclass.
- **Scope.** `root` bounds what is mounted. `read` and `write` bound the baseline permissions. A push uploads and deletes only within `write`, so a file written elsewhere in the mount never leaves the container.
- **Permissions are a baseline the handler owns.** The rules follow Claude Code's absolute-path syntax, `Read(//abs/glob)` and `Edit(//abs/glob)`. The context carries them per filesystem and merged. The handler passes them to `runAgent` or not, extending them through `composeOptions`. Procedures run in `dontAsk` mode, so a path with no allow rule is denied.
- **Path.** `S3Filesystem` requires one, so prompts can reference it statically. `ScratchFilesystem` defaults to a directory of the task's own. Two tasks in one container on a static path are the consumer's to prevent, through `runtimeSessionId`.
- **S3 engine unchanged.**
  - `s7cmd sync`, with `--check-etag` on push, `--delete` on the final push when `dangerouslyEnableDeletes` is set (never on a checkpoint), and one `--filter-exclude-regex` that always excludes `..` segments. A checkpoint adds `--filter-mtime-before`.
  - The write scope becomes a filter on the push.
  - `dangerouslyEnableDeletes` is off by default and requires a non-empty `root`. `--delete` removes whatever is missing locally, including objects another writer added since the pull; deleting only what the task removed would race too, since S3 cannot check and delete atomically.
- **Errors → outcomes:**

  | Failure | Outcome |
  |---|---|
  | Pull or mount fails | the task fails, `FILESYSTEM_UNSYNCED` (retryable) |
  | Push fails on a completed task | `FAILED`, `FILESYSTEM_UNSYNCED` |
  | Push fails on a failed task | the original cause, with the push's failure appended to its message |
  | Checkpoint fails | logged; the final push decides |
  | Invalid options, an undeclared bucket name, or `s7cmd` exit 2 | `EXECUTION_ERROR` |

- **Tests:**
  - Unit tests: the registry semantics (append, replace by name, `inherit: false`); mounting before the handler and unmounting per ending; scope and baseline rules; the S3 arguments against a scripted `s7cmd`.
  - Kept: `integ/aws/filesystem-s3-sync`.
  - `hello-agent`'s notebook, running on the baseline permissions without `additionalDirectories`, is the e2e proof that the baseline works.

## Risks / Trade-offs

- [The baseline's `Read` rules outside `cwd` do not let the agent read, in `dontAsk`] → the `hello-agent` e2e fails loudly. The handler can then add `additionalDirectories` itself; no design change.
- [`s7cmd` is maintained best-effort] → it stays pinned by sha256 and admitted through the integ test.
