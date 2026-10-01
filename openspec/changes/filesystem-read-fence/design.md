# Design

## Context

See proposal.md — Why. It builds on `filesystem-local-isolation`: a mount's `localPath` is the resolved `<localRoot>/<subpath>`, and no two live tasks hold overlapping ones.

What holds today:
- **Scope.** `FilesystemScope` carries `read` and `write` globs. A mount's baseline rules are `Read(/<localPath>/<read>)` and `Edit(/<localPath>/<write>)`, and `context.filesystemPermissions.allow` merges them.
- **Examples.** golden-kata's base options already pass its kata directory as `additionalDirectories`. smoke-coverage passes only the allow rules.
- **Scaffold.** The plugin's base-options scaffold is `{ settingSources: ['project'] }`.
- **The spike** ([research](../../../docs/research/claude-agent-sdk.md), 2026-10-02):
  - in `dontAsk` a path outside the working directories is unreadable unless a `Read` rule names it;
  - the fence overrides even that rule;
  - a directory in `settings.permissions.additionalDirectories` is readable;
  - the auto-memory directory stays readable.

## Goals / Non-Goals

**Goals:**
- A fenced run reads its own working directory and its task's mounts, and nothing else of the container's files a task could hold.
- Fenced by default for a generated project, with a procedure able to opt out.

**Non-Goals:**
- Fencing Bash that is not read-only.
- Enforcing the fence from the kernel.

## Decisions

### The handler gets the mounted directories; the SDK option adds them

```ts
export interface TaskContext {
  // …as today
  readonly filesystems: Readonly<Record<string, MountedFilesystem>>;
  readonly filesystemPermissions: { readonly allow: readonly string[] };
  /** Every mounted filesystem's `localPath`, to give a run as `additionalDirectories`. */
  readonly filesystemDirectories: readonly string[];
}

export interface FilesystemScope {
  readonly subpath: string;
  /** Globs relative to the mount; the whole mount by default when the filesystem pushes, none when it does not. A push never leaves them. */
  readonly write?: readonly string[];
}
```

A procedure gives a run its mounts the same way it gives it their rules:

```ts
options: composeOptions(baseOptions(), {
  additionalDirectories: [...context.filesystemDirectories],
  allowedTools: [...context.filesystemPermissions.allow],
}),
```

*Why the SDK option and not `settings.permissions.additionalDirectories`.* The SDK option passes each directory as `--add-dir`, so a mount's `.claude/` skills, commands and subagents load. That is the operator's choice: a mounted repository or workspace carrying its own skills is a use case, not a hazard. `CLAUDE.md` from an added directory still loads only under `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`.

*Why the handler, not the kernel.* [ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md) gives the handler the agent's permissions, and the kernel never sees mounts. A run that is not given its mounts under the fence fails loudly: its reads are refused.

### The read scope goes; the baseline keeps `Read` on the whole mount

Under the fence a mount is readable only as a working directory, which is readable whole. Without the fence, in `dontAsk`, adding the mount also makes it readable whole. Either way a `read` narrower than the mount binds nothing, and nothing outside tests declares one. The baseline keeps `Read(/<localPath>/**)` so a run that passes the allow rules but not the directories still reads its mounts when it is not fenced. `write` still bounds every push and the `Edit` rules: `dontAsk` denies an edit no rule allows, inside a working directory or not.

### The fence is the generated project's default

The base-options scaffold becomes:

```ts
export function baseOptions(): AgentOptions {
  return {
    settingSources: ['project'],
    settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
  };
}
```

`composeOptions` merges `settings` key by key, so a procedure turns it off with `settings: { permissions: { blockReadsOutsideWorkingDirectories: false } }`, and the auto-memory settings of the next change merge beside it. Scaffolds are written once, so golden-kata's and smoke-coverage's base options gain the setting by hand, as an existing consumer's would.

*Alternatives:* the kernel always fencing, which would add friction a procedure cannot remove (CLAUDE.md, "Never add friction"); and leaving it to each consumer, which would mean an unfenced default.

## Error handling

Nothing new fails in AgentForge. A procedure that still declares `read` gets a type error. At run time the strict options parse refuses an unknown key in the options, but `scope` returns an object the base class reads. The resolve step therefore refuses a scope carrying `read`, and the task fails `EXECUTION_ERROR` naming it, rather than ignoring the key.

| Failure | Outcome |
|---|---|
| A scope returns `read` | `EXECUTION_ERROR` before anything is mounted, naming the key |
| A fenced run that was not given its mounts reads one | the tool is refused in the agent's turn, as Claude Code refuses it; the run's outcome is the procedure's |

## What earns which test

- **Model `integ`, because it can drift:** `integ/model/read-fence/`, through `runAgent`. The fence is new in Claude Code (v2.1.257), and AgentForge's §REQ403 claim rests on it. Fenced, with one directory given as `additionalDirectories` and an allow rule naming a sibling:
  - `Read` of the given directory succeeds;
  - `Read` of the sibling is refused, and so is `cat` through Bash.

  The assertions read the tool results, which hold whichever way the model words its reply.
- **Unit:**
  - `filesystemDirectories` lists every mount;
  - the baseline rules without a read scope;
  - a scope carrying `read` refused;
  - the scaffold's snapshot.
- **e2e, local and on AgentCore:** golden-kata and smoke-coverage run fenced and pass as they do. That shows the fence leaves skills, the base layer's `.claude/` and the mounts readable.
- **Settled once:** the spike is the dated research note.

## Risks / Trade-offs

- [The fence refuses a file a skill or the base layer reads outside the agent's directory, such as a skill's reference file read with `Read`] → Claude Code keeps the files it needs readable. The e2e suites run golden-kata's `kata-style` skill fenced; if one is refused, the base layer's directory is added as a working directory in the examples' base options, and the finding is recorded.
- [**BREAKING** `read` removal] → No consumer is live, and nothing outside tests declares it.
- [A mount with a `.claude/` folder brings skills into the run] → Intended. A consumer that does not want it keeps `.claude/` out of the mounted subtree.
