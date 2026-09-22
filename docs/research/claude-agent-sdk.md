# Claude Agent SDK — Verified Facts

Read at the source on 2026-09-20. Only what bears on AgentForge's design. Behavior the predecessor harness relied on is **not** recorded here as fact — it is re-established by the settlement spike, [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §E.

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
- **Mirror writes are best-effort:** up to three attempts, then the batch is dropped, an error is logged and a `{ type: "system", subtype: "mirror_error" }` message is emitted. Retries can re-deliver entries, so an adapter deduplicates by `entry.uuid`.
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
- Schemas must target **draft-07** — `z.toJSONSchema(schema, { target: 'draft-7' })`. `format` is accepted as an annotation.
- An invalid schema now fails at startup rather than being ignored (since CLI v2.1.205).

What remains for AgentForge is the outer validation and the typed `output_invalid` outcome, not a pile of conversion workarounds.

**The rest of §E is now settled by spike** — see [`kernel-settlement.md`](kernel-settlement.md), read 2026-09-22 against `0.3.278`. In particular: the submission is carried by a real tool named `StructuredOutput` that is advertised in `init.tools`, so a `PreToolUse` matcher can name it *and* assert it at startup; a matcher naming a tool that does not exist fires zero times, silently.

## What this means here

- The working directory is not cosmetic: it keys the project, the transcript location, and the store lookup. A procedure that changes it changes where its session lives (H15).
- Cross-container resume (H14) has two candidate mechanisms — the store adapter or a persistent mount — which differ in what the base image and the CDK constructs must provide. Decided by spike, `DESIGN_OPTIONS.md` §F.
- Mirror failure is a real failure mode to surface rather than swallow: `mirror_error` must reach the task record, not be logged and forgotten.


## Settings sources and capability composition — verified 2026-09-22

`settingSources?: ("user" | "project" | "local")[]`, default **all three**; `[]` loads none. Precedence lowest to highest is **user → project → local**, merged key by key; array settings such as `permissions.allow` combine across scopes rather than replacing.

**Three kinds of configuration follow three different rules**, which is the thing to get right ([`capability-composition.md`](capability-composition.md)):

| Kind | Loads from |
|---|---|
| `settings.json` and hooks | **`<cwd>/.claude/` only — no parent fallback** |
| `CLAUDE.md` and `.claude/rules/*.md` | `<cwd>` and every parent |
| skills, commands, subagents | `<cwd>` and every parent **up to the repository root** |

So nested directories compose *capabilities* but not *settings*. Per-layer and per-procedure settings come from the **`settings` option** — an inline object, a file path or a JSON string populating the flag-settings layer in the precedence order, passed per query.

`additionalDirectories` is two different things with one name: **the SDK option** is passed to Claude Code as `--add-dir` and *does* load skills, commands and subagents (plus `enabledPlugins`/`extraKnownMarketplaces`, and `CLAUDE.md` only under `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`), while **`permissions.additionalDirectories`** in a settings file grants file access and loads nothing.
