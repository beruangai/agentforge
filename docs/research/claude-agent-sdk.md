# Claude Agent SDK — Verified Facts

Read at the source on 2026-09-20. Only what bears on AgentForge's design. Behavior the predecessor harness relied on is **not** recorded here as fact — it is re-established by the settlement spike, [`kernel-settlement.md`](kernel-settlement.md).

## Sessions

From [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions):

- A session is the conversation the SDK accumulates; it is written to disk automatically. Within one `query()` call the agent takes as many turns as it needs.
- **Continue** picks the most recent session in the current directory; **resume** takes a specific session id; **fork** starts a new session from a copy of another's history, leaving the original untouched.
- The session id is on the result message, and in TypeScript also on the init system message.
- Transcripts live at `~/.claude/projects/<encoded-cwd>/*.jsonl`, or under `$CLAUDE_CONFIG_DIR/projects/`. The encoding replaces every non-alphanumeric character in the absolute working directory with `-`. **So the working directory decides the project a session belongs to.**
- "Session files are local to the machine that created them." Resuming elsewhere needs a session store, moving the file, or not relying on resume at all.
- `persistSession: false` keeps a session in memory only.

## Session storage

From [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage):

- A `SessionStore` adapter mirrors transcripts to an external backend so "a session created on one host can be resumed on another host running from a matching working directory". Required methods `append` and `load`; optional `listSessions`, `listSessionSummaries`, `delete`, `listSubkeys`.
- `SessionKey` is `{ projectKey, sessionId, subpath? }`; `projectKey` encodes the working directory, and `subpath` addresses a subagent transcript. Resuming subagent transcripts requires `listSubkeys`.
- **Dual write:** the subprocess always writes locally first and the SDK forwards the batch to the store. On a run resumed *from the store*, the local copy is deleted at run end, so the store holds the only durable copy.
- **Mirror writes are best-effort:** up to three attempts, then the batch is dropped, an error is logged and a `{ type: "system", subtype: "mirror_error" }` message is emitted. **A call that times out is not retried.** Retries can re-deliver entries, so an adapter deduplicates by `entry.uuid`.
- **Flushing is batched by default** — `sessionStoreFlush: 'batched'` flushes at the end of a turn — so a container that dies mid-turn loses what was not yet flushed; `'eager'` flushes as entries arrive. Loading from the store times out after `loadTimeoutMs`, 60 s by default. The store API is marked `@alpha` (re-read 2026-09-24).
- **Resuming from the store swaps the config directory.** The SDK writes the loaded session into a temporary directory and runs the CLI with `CLAUDE_CONFIG_DIR` pointing there, seeding only credentials, `.claude.json` and the user `settings.json`. Whatever else the user scope held — skills, subagents, commands, `CLAUDE.md` — is not there on a resumed run unless it is supplied another way (re-read 2026-09-24; not yet measured, [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §ODO008).
- Conflicts: `persistSession: false` and file checkpointing both throw at startup when combined with a store.
- Reference adapters for S3, Redis and Postgres ship in the SDK repositories, with a conformance suite. Retention is the adapter's responsibility; the SDK never deletes.

## The project directory name

From [Manage sessions](https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself):

- By default `<project>` is "your working directory path with non-alphanumeric characters replaced by `-`"; a converted name over 200 characters is truncated and given a hash of the full path.
- `CLAUDE_CODE_PROJECT_DIR_NAME` overrides it, and transcripts *and* auto memory go under that name "whatever the working directory is". Requires CLI v2.1.234 or later.
- **"Use 1-64 letters, digits, hyphens, or underscores"** — no slashes, no dots — and not a Windows device name such as `con`.
- **An invalid value fails silently:** "Claude Code ignores any other value and uses the derived name." So a bad key does not error, it scatters transcripts under a path-derived name and quietly breaks resume — which has to be checked rather than trusted.
- It is ignored altogether unless `CLAUDE_CONFIG_DIR` is set too, and it is read once at startup from the process environment, so a settings file cannot supply it.

## Structured output

Established against the current SDK, superseding the predecessor harness's workarounds:

- `outputFormat: { type: 'json_schema', schema }` is native. The SDK validates and re-prompts on its own; exhausting its retries surfaces as `error_max_structured_output_retries`.
- **Verified 2026-09-25** (`@anthropic-ai/sdk` 0.128.0, `integ/model/structured-output/`): the kernel converts through the SDK's `transformJSONSchema`, which walks `$defs` (not draft-07's `definitions`, so Zod's default target is used), throws on a node with no `type` and no union (so reuse is inlined), closes every object, rewrites `oneOf` as `anyOf`, and folds `enum`, `const` and any unsupported keyword into the description — the kernel puts `enum` and `const` back. Structured output is a tool, so its schema's root must be an object.
- **Enforcement is the CLI's, in the turn, not the backend's** (spiked 2026-09-25, `claude-sonnet-5`): there is no constrained decoding — the model can submit unparseable JSON — and the CLI validates each `StructuredOutput` call against the schema, answering a violation with an `is_error` tool result the agent retries against (`must be equal to one of the allowed values`, `must be integer`). `enum`, `const`, `type` and `required` are enforced this way; **`format` is not** — `"not a url at all"` for `format: uri` and `"banana"` for `format: uuid` were accepted as `success`. With `format` present the run still engaged structured output, so the predecessor's "`format` makes the backend fall back to prose" did not reproduce. A contract's `format` (and any refinement) was therefore caught only by the kernel's parse after the run, as `OUTPUT_INVALID`, with no in-turn retry. **Since 2026-10-01** the kernel's structured output validation parses each submission against the contract in a `PreToolUse` hook, so they are refused in-turn and the agent answers again ("Holding an answer back in-turn" below; `integ/model/structured-output-validation/`).
- An invalid schema now fails at startup rather than being ignored (since CLI v2.1.205).

What remains for AgentForge is the outer validation and the typed `OUTPUT_INVALID` outcome, not a pile of conversion workarounds.

**Settlement is settled by spike** — see [`kernel-settlement.md`](kernel-settlement.md), read 2026-09-22 against `0.3.278` and re-run 2026-09-24 against `0.3.280`. In particular: the submission is carried by a real tool named `StructuredOutput` that is advertised in `init.tools`, so a `PreToolUse` matcher can name it; a matcher naming a tool that does not exist fires zero times, silently.

## Reading how a run ended — re-read 2026-09-24 against `0.3.280`

- **A limit yields its result, then the iterator throws.** "A single message `query()` call raises an error that includes the failure text after yielding the final result message" ([streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)); the recorded `maxTurns` and `maxBudgetUsd` runs show exactly that, `subtype: error_max_turns` / `error_max_budget_usd` first.
- **`terminal_reason` names why a result ended** — `completed`, `max_turns`, `budget_exhausted`, `structured_output_retry_exhausted`, `api_error`, `aborted_streaming`, `aborted_tools`, `hook_stopped`, among others — and `api_error_status` carries the provider's HTTP status. Assistant messages carry `error: 'authentication_failed' | 'rate_limit' | 'overloaded' | 'billing_error' | …`, and an `auth_status` message exists. A `rate_limit_event` with `status: 'rejected'` carries `resetsAt`. These are what an outcome is classified from; an error's text is not.
- **Control requests — `interrupt()` among them — are "only supported when streaming input/output is used"** (`sdk.d.ts`). In the string-prompt form only an `AbortController` reaches the run. A CLI stopped by `SIGTERM` "leaves the turn that was in progress unfinished and records no result" ([headless](https://code.claude.com/docs/en/headless)).
- **Background work is observable.** `system/background_tasks_changed` carries the whole live set each time; `task_started.is_backgrounded` flags backgrounded work; a result produced by a background task's completion carries `origin.kind: 'task-notification'`.
- **Subagents run in the background by default** since CLI 2.1.198 — an `Agent` call that omits `run_in_background` launches a background subagent ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` removes `run_in_background` from Bash **and the subagent tool** and turns off auto-backgrounding ([environment variables](https://code.claude.com/docs/en/env-vars)); the `env` option sets it per query.
- **A resumed session keeps what it started with.** `systemPrompt` is recorded on first use; on `resume` a different one is ignored until compaction or a new session. `total_cost_usd` and `modelUsage` continue from the transcript, while `maxTurns` and `maxBudgetUsd` count only this `query()`.
- **Telemetry is correlated for free**: with an active span the SDK passes `TRACEPARENT`/`TRACESTATE` to the CLI. The CLI's export on exit "is bounded by a short timeout" and fails silently by default ([observability](https://code.claude.com/docs/en/agent-sdk/observability)).
- The subagent tool is `Agent` in `tool_use` blocks and `Task` in `init.tools` ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)); a hook matcher containing regex characters is an unanchored regex ([hooks](https://code.claude.com/docs/en/hooks#matcher-patterns)).

## What this means here

- The working directory is not cosmetic: it keys the project, the transcript location, and the store lookup. AgentForge pins nothing: the project key is the SDK's own, derived from the run's cwd — the agent's directory unless a procedure sets `cwd` — so a resume must run from the directory its session began in ([ADR 0011](../../adr/0011-state-persists-through-apis-not-mounts.md)).
- Cross-container resume (§REQ402) goes through the store adapter; mounts were ruled out ([ADR 0011](../../adr/0011-state-persists-through-apis-not-mounts.md)). Whether a resumed run misses anything its config directory held beyond the transcript is open, §ODO008.
- Mirror failure is a real failure mode to surface rather than swallow: `mirror_error` must reach the task record, not be logged and forgotten.


## Settings sources and capability composition — verified 2026-09-22

`settingSources?: ("user" | "project" | "local")[]`, default **all three**; `[]` loads none. Precedence lowest to highest is **user → project → local**, merged key by key; array settings such as `permissions.allow` combine across scopes rather than replacing.

**Three kinds of configuration follow three different rules**, which is the thing to get right ([`capability-composition.md`](capability-composition.md)):

| Kind | Loads from |
|---|---|
| `settings.json` and hooks | **`<cwd>/.claude/` only — no parent fallback** |
| `CLAUDE.md` and `.claude/rules/*.md` | `<cwd>` and every parent |
| skills, commands, subagents | `<cwd>` and every parent **up to the repository root** |

Observed 2026-09-25 in the agentic-project image, cwd `/workspace/agentic/agent` with `settingSources: ['project']` and no repository: the parent's `/workspace/agentic/.claude/CLAUDE.md` and `.claude/skills/house-style` both loaded. So nested directories compose *capabilities* but not *settings*. Per-layer and per-procedure settings come from the **`settings` option** — an inline object, a file path or a JSON string populating the flag-settings layer in the precedence order, passed per query.

`additionalDirectories` is two different things with one name: **the SDK option** is passed to Claude Code as `--add-dir` and *does* load skills, commands and subagents (plus `enabledPlugins`/`extraKnownMarketplaces`, and `CLAUDE.md` only under `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`), while **`permissions.additionalDirectories`** in a settings file grants file access and loads nothing.

## In-process MCP servers, skills and permissions — read 2026-09-30 against `0.3.280`

Read from the SDK's [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools.md), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md) and [skills](https://code.claude.com/docs/en/agent-sdk/skills.md) pages, and the installed `sdk.d.ts`, for `golden-kata`'s base layer.

- **An in-process server** is `createSdkMcpServer({ name, version, tools, alwaysLoad? })` over `tool(name, description, zodShape, handler)`; its tools are named `mcp__<key in mcpServers>__<tool>`. A handler returns `{ content, isError? }`; a thrown exception becomes an error result carrying its message, and the loop goes on. Tool search defers SDK MCP tools by default; `alwaysLoad: true` on the server keeps their schemas in the first prompt. The config holds a live `McpServer` instance: `composeOptions`'s deep merge copies only plain objects, so the instance passes through by reference.
- **`dontAsk`** denies every call that would prompt and never calls `canUseTool`. Calls an allow rule approves run, and so do calls that need no approval in `default` mode — among them file reads inside the working directories, the cwd and each `additionalDirectories` entry. Allow rules take tool-name globs only after a literal `mcp__<server>__`; `Edit(path)` rules govern every built-in that writes, `Write` included; `//path` anchors at the filesystem root.
- **Skills** load through the `user` and `project` setting sources from `<cwd>/.claude/skills/`, every parent up to the repository root, and each `additionalDirectories` entry's `.claude/skills/`. `tools` restricts built-ins, so `Skill` must be listed there for skills to be invocable; the `skills` option, when set, adds `Skill` to `allowedTools`.

## Auto memory in an SDK run — spiked 2026-10-01 against `0.3.280` (CLI 2.1.284)

From [How Claude remembers your project](https://code.claude.com/docs/en/memory.md), and a spike: two `query()` runs on Haiku 4.5, each in a fresh working directory, with `settingSources: ['project']`, `permissionMode: 'dontAsk'` and `settings: { autoMemoryDirectory }` naming one temporary directory. The first run was asked to remember a codename; the second, with `tools: []`, was asked to recall it.

- **`autoMemoryDirectory` takes effect from the SDK's `settings` option.** The init message's `memory_paths.auto` names it. The setting must be an absolute path or start with `~/`. Set in a project's settings file instead, it is honoured only under workspace trust.
- **Recall needs nothing else.** `MEMORY.md`'s first 200 lines or 25 KB load into context whatever the system prompt: the default, the `claude_code` preset, or a custom string all recalled the codename with no tool call.
- **Saving needs instructions, not the preset.** Under the default system prompt the model said it had no persistent memory and wrote nothing. Under the preset it wrote a topic file and the `MEMORY.md` index in the directory, with `Write` and `Edit` in `tools` and **no allow rule for the directory**: under `dontAsk`, writes to the auto-memory directory need no approval. A run without `Write` or `Edit` cannot save.
- **An instruction fragment replaces the preset.** Spiked the same day: a custom `systemPrompt` (`string[]`) holding only a memory fragment, and the fragment after a procedure's own prompt. Both times the agent saved a topic file with the frontmatter the fragment describes and indexed it in `MEMORY.md`; a later run with the default prompt and no tools recalled it. The fragment names the directory, when to save, the file format and the index rule. The preset's memory section, like most of the preset, is for software development, and AgentForge does not use the preset.
- A recall without `Read` sees only the index: a detail kept only in a topic file is missing.
- Claude Code stamps each topic file's frontmatter with `node_type`, `originSessionId` and `modified`, whatever wrote it. The directory sits outside `CLAUDE_CONFIG_DIR`, so the config directory swapped on a run resumed from the store (above) does not affect it.
- **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off** — checked 2026-10-08, same SDK: without the variable, a run with no `autoMemoryDirectory` reports `memory_paths.auto` as `<CLAUDE_CONFIG_DIR>/projects/<cwd>/memory/`; with it, `memory_paths` is absent. The kernel sets it on every run that declares no memory directory; `integ/model/auto-memory/` re-verifies it.
- **Under the read fence the memory directory stays readable and writable** though it is not a working directory — checked 2026-10-08: a fenced run saved to a directory outside its working directories, and a later fenced run recalled from it (`integ/model/auto-memory/`).

## Holding an answer back in-turn — spiked 2026-10-01 against `0.3.280` (CLI 2.1.284)

One `query()` on Haiku 4.5 with an `outputFormat` schema and no other tools. The question was whether a check can make the agent fix its answer before the run ends.

- **A `Stop` hook cannot.** It fired once, after the agent had submitted its answer through `StructuredOutput`. Its `decision: 'block'` changed nothing: the run ended `success` with the first answer, in two turns.
- **A `PreToolUse` hook on `StructuredOutput` can.** `StructuredOutput` is in `init.tools`, so a matcher on it is live. Denying the submission with a reason returns that reason to the agent as the tool's error. The agent resubmitted a corrected answer in the same run, and the result's `structured_output` was the accepted resubmission.
- **The CLI bounds it.** A hook that always denies ends the run `error_max_structured_output_retries` after five attempts: "Failed to provide valid structured output after 5 attempts — last StructuredOutput error: …", carrying the hook's last reason. The SDK then throws after the result. The limit is the CLI's structured-output retry limit, `MAX_STRUCTURED_OUTPUT_RETRIES`, shared with schema failures. The bound is a ceiling, not a guarantee of five attempts: under a refusal that cannot be met, Haiku 4.5 gave up after two and ended its turn with text, a `success` result with no `structured_output` (2026-10-01, `integ/model/structured-output-validation/`).

## Reads outside the working directories — spiked 2026-10-02 against `0.3.280` (CLI 2.1.284)

From [Configure permissions](https://code.claude.com/docs/en/permissions.md) ("Working directories", "Additional directories grant file access, not configuration") and a spike: Haiku 4.5 in `dontAsk`, with `settingSources: []` and a sandboxed config directory. `settings.permissions.additionalDirectories` named one mounted directory. An auto-memory directory and an allow rule `Read(/<allowed>/**)` were also set, and each run was made with `permissions.blockReadsOutsideWorkingDirectories` on and off.

- **`permissions.additionalDirectories` takes effect from the SDK's `settings` option, with no workspace trust.** The directory was readable by `Read` and by `cat` with no allow rule. The SDK's own `additionalDirectories` option is different: it is passed as `--add-dir`, and such a directory also loads skills, commands, subagents and `enabledPlugins` from its `.claude/`. AgentForge passes mounts through the SDK option, by the operator's choice: a mount carrying its own `.claude/` is a use case. Such a directory is a working directory under the fence too — `integ/model/read-fence/` re-verifies it.
- **In `dontAsk`, a path outside the working directories is already unreadable unless a `Read` allow rule names it.** With the fence off, `Read`, `Grep` and a read-only `cat` of such a path were all denied. So was `cat` under an explicit `Bash(cat *)` allow rule, as the docs say of `tee`: a Bash rule allows the command, not a path outside the working directories.
- **The fence overrides allow rules.** With it on, the path the `Read(/<allowed>/**)` rule named was refused: "is outside <the working directories>". Under the fence, a directory is readable only as a working directory.
- **The auto-memory directory stays readable under the fence**, though it is not a working directory, and `init.memory_paths.auto` still names it.
- **What this means for AgentForge:** procedures run in `dontAsk`, and a mount's baseline rules name only its own directory, so file tools and read-only Bash already cannot read another task's mount. The fence adds protection against a broad `Read` allow rule a procedure grants, and against a mode other than `dontAsk`. It does not constrain what an allowed command reads once it runs, such as an interpreter running a script; it does deny a command the parser cannot trace (below, 2026-10-08). It would make a mount readable only as a working directory, and a working directory is readable whole, so a mount's narrower `read` scope would no longer bind.
- **Under the fence, a command the shell parser cannot trace is denied in `dontAsk`, even under an allow rule; every other allowed command runs** — observed 2026-10-08 against `0.3.280`, in the Debian agent image, as [settings](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories) and [permission modes](https://code.claude.com/docs/en/permission-modes#actions-no-mode-auto-approves) say: such a command prompts in every mode "even when it names no outside path", and `dontAsk` turns the prompt into a denial. With allow rules for each: `python -c "print(1)"` and `sh -c "echo 1"` — code passed as a string — were denied with the fence on and ran with it off; no working directory lifted it (the venv, or `/`, added through `settings.permissions.additionalDirectories` or the SDK's `additionalDirectories`). `echo plain`, `cat` of a file in the cwd, `python3 -m pip show …` and `python script.py` ran either way, the last two reading the venv outside the working directories: the fence does not inspect what a process reads. `echo $(…)` and `cat` of an outside path were denied either way, by `dontAsk` alone. So a procedure whose agent runs code ships it as a file in its layer and runs that, as `smoke-coverage`'s `ReportNautilusTraderVersion` does, or lifts the fence in its own options — the fence is a scaffolded base option, and `composeOptions` lets a later `false` win.

## Cache breakpoints in a prompt — observed 2026-10-08 against `0.3.280`

- **Claude Code adds one-hour cache breakpoints of its own after the prompt AgentForge sends**, on the operator's subscription. A prompt block marked with a five-minute breakpoint (`ttl: '5m'`) failed the run before its first turn: API 400, "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block". Seen in golden-kata's e2e, the first run to mark a block.
- **What this means for AgentForge:** `cache: true` and a command's cache markers render `ttl: '1h'`, which is valid before a breakpoint of either length. A procedure that asks for `5m` itself fails the same way, loudly.
