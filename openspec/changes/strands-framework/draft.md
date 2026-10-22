## Why

The operator decided on 2026-10-22 to support Strands Agents as a second framework beside the Claude Agent SDK (`claude`). The framework is chosen per agentic project ([ADR 0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md), proposed), behind the seam `framework-seam` cuts. **This is not a migration; both stay, for different use cases:**

- **`claude` for coding.** Claude Code's file editing, Bash and search are what an agentic coding task such as StrategyFoundry's `rnd.implement` needs.
- **Strands for non-coding work,** in separate agentic projects in the same solution: for example a code-agents project and a non-code-agents project.

A project's guardrails, hooks and tools are its framework's, and none of them is reusable across frameworks. That is why the choice is per project.

**The reason is lower-level control over the agent loop:** less magic and more built-in capabilities. A large part of the `claude` framework exists to manage Agent SDK and Claude Code semantics:

- the kernel's settlement and classification
- the structured-output hook
- `.claude/` layering
- auto memory
- the `SessionStore` mirror check
- the CLI's remapped telemetry

Strands' loop is a library AgentForge drives in-process. It brings:

- native OpenTelemetry `gen_ai.*` spans;
- middleware around the model and tool stages;
- interventions and Cedar authorisation per tool call;
- S3-backed sessions, context offloading and memory;
- no CLI subprocess (each Claude task's CLI costs about 165 MB).

**The model is still Anthropic's Claude, through the Anthropic API directly,** for full feature parity with it. The operator ruled out Bedrock on 2026-10-22: model-usage-limit approvals, and Bedrock's lag behind the API. Provider freedom is not a goal.

Strands cannot use the operator's subscription, so a Strands project bills per use, with an API key. **The budget is the Anthropic Console's monthly spend limit.** A gateway (LiteLLM, which needs a PostgreSQL database for budgets) is deferred. Budgeting fills a gap for this framework; it is not a reason for it.

What holds in TypeScript, checked at the source on 2026-10-22. `strands-agents/sdk-typescript` is archived; the code now lives in the `strands-agents/harness-sdk` monorepo.

- **SDK.** `@strands-agents/sdk` is at 1.22.0. 1.0 shipped 2026-04-30, and minors arrive roughly weekly.
- **Harness.** `@strands-agents/harness` is at 0.3.1 (first release 2026-09-21), and its minors break.
- **Structured output** takes Zod 4 through a `strands_structured_output` tool. An invalid submission goes back to the model with **no retry cap of its own**. Only the **first** submission in a message counts. A model that never calls the tool is forced once, then `StructuredOutputError` is thrown.
- **Storage.** S3 storage for sessions, offloading and memory exists. TS throws without a storage backend.
- **Anthropic provider.** It supports prompt caching (`cacheConfig` with a TTL), extended thinking with `effort`, and betas.
- **Cancel.** An `AbortSignal` is passed to the provider and checked at fixed points in the loop.
- **Telemetry.** Token usage includes cache reads and writes. **No cost in USD** is reported.
- **Defaults that fail silently, against AgentForge's rule:**
  - An MCP server that fails to start yields no tools unless `continueOnError: false`.
  - The harness runs subagents in the background, and lets the model background any tool.
  - Memory extraction runs in the background and is lost without `agent.shutdown()`.
- **Shell and file tools.** The harness's default sandbox runs "on the host with no isolation". There is no VFS.
- **What AgentForge does not use:**
  - Strands' A2A is 0.3, with no `CancelTask` and an in-memory task store.
  - Its TS AgentCore path is an Express sample over HTTP.

  AgentForge's A2A 1.0 runtime stays the boundary, and Strands is only the loop inside a task.
- **Bun compatibility** is unknown.

## What Changes

- **A spike first** (findings to `docs/research/strands-agents.md`, dated), before any surface is fixed:
  - the SDK under Bun, in the task process;
  - `S3Storage` sessions against the local store's SeaweedFS and S3, resumed in another container;
  - block-level prompt caching on the Anthropic API with explicit cache points and the SDK's automatic placement off;
  - structured-output settlement under the rules below;
  - cancel latency mid-tool;
  - a write-scope Cedar intervention fed by a `contextEnricher` that matches the relative globs, refusing an edit outside them through the file and shell tools;
  - what the Anthropic API answers when the Console's spend limit is reached.
- **The Strands framework behind the seam, in `src/framework/strands/`,** replacing the stub `framework-seam` commits, with entry points `/strands/agent` and `/strands/server`. Its vended oRPC middleware, appended after the filesystem mount, turns the mounts' permissions (bare actions on relative-glob resources) into Strands' own options. `runAgent` drives a Strands `Agent` on the Anthropic provider and keeps every rule the `claude` kernel keeps:
  - **One outcome (§REQ206):** no background work, subagents foreground.
  - **In-turn validation (§REQ208):** against the agent contract and every stop guard, all failures told at once, bounded by a cap the kernel enforces since Strands has none. Still failing at the cap is `OUTPUT_INVALID` with the last refusal.
  - **Cancel (§REQ304):** the cancel signal, then abort after a grace, then the group kill.
  - **Classification from fields, never text (§REQ501),** onto the shared causes with the same semantics as `claude`: the same provider answers both.
  - **Fail closed (§REQ201):** every MCP server `continueOnError: false`; a hook that can never fire fails the run.
  - **The run record (§REQ601):** the shared fields, the raw Strands usage, and no USD cost (it is optional).
- **Context and caching (§REQ210).** `composeContext` renders to Strands content blocks, and a cache breakpoint becomes a block-level cache point. Prompt caching is the framework's.
- **System prompt.** AgentForge's fragments are appended to the procedure's prompt, as ADR 0017 does for `claude`; whether ADR 0017 generalises is an open question.
- **Sessions (§REQ402).** Strands sessions persist in the project's session bucket under the agent's name, and resume by id in any of the agent's containers. They do so locally through the local store (ADR 0020). A write the store did not accept fails the run, as the Claude mirror check does.
- **Filesystems.** The shared lifecycle is unchanged. The write scope is enforced by a **Cedar authorization intervention** (`@strands-agents/sdk/vended-interventions/cedar`). The framework's util renders it from each mount's permissions, and each mount becomes a working directory of the file and shell tools.

  What the Strands TS source shows (checked 2026-10-22):
  - The Cedar action is the tool name.
  - The resource is fixed by config (`Resource::"agent"` by default).
  - The tool's arguments are `context.input`, and a `contextEnricher` adds fields (`cedar.ts:71,181-186`).

  So a glob cannot be the Cedar resource. Cedar's `like` has only `*`, which also matches `/`, so it cannot express a glob's single-segment `*`. The likely shape: the enricher resolves the tool's path against the mounts and records whether it is inside a write glob, using the matcher `writablePath` already uses. The policy then permits `edit` actions only when that holds. This is to be confirmed in the spike.

  The read fence is `claude`'s. Strands' reads follow its own shell and file tool semantics, plus Cedar.
- **`distill` for Strands,** its own utility run (`framework-seam` keeps `distill` in `claude`).
- **Transcript utilities, if a caller or procedure needs them,** are the framework's own, in `/strands/client`, reading Strands' session storage, as `claude`'s `readTranscript` is in `/claude/client` (`framework-seam`).
- **Telemetry (§REQ602).** Strands' OTel spans go through the ADOT collector with no remapping. The Strands image's collector configuration is its own.
- **Credentials.** §REQ705 is withdrawn and replaced (Dependencies). A Strands project declares `ANTHROPIC_API_KEY` as its framework's required secret, in `framework/strands/core/`, which its server, infra and plugin parts import, as `claude`'s does. On AgentCore it is a Secrets Manager secret mapped by `AgentRuntime`, like the OAuth token.
- **The image.** `agentforge/a2a-strands`, with no Claude binary. Built from `framework/strands/Dockerfile`, composed with the shared base as the `claude` image is (`framework-seam`).
- **The plugin.** `agentic-project --framework strands` records the framework, rendered from `framework/strands/plugin/`,, and renders the base layer `FROM` the Strands image, Strands base options, the layers' instruction and skill directories, and the secret. `agent` and `sync` follow the project's framework.
- **An example,** generated by the plugin (§REQ709), of a non-coding project, verified end to end locally and on AgentCore against a real model. It covers:
  - a typed output and in-turn validation with a stop guard;
  - a resume in another container;
  - an attach;
  - a cancel mid-tool;
  - a container stop ending `LOST`;
  - a filesystem across containers;
  - a call through the Temporal activity.
- **Tiers.** `integ/model/` gains the Strands slices AgentForge relies on and cannot learn more cheaply: structured-output settlement, and cache points honoured.
- **Guidance.** The `claude-plugin` skill gains the Strands framework: when to choose it, defining, implementing, credentials (§REQ712).

## Capabilities

- New: `framework-strands-settlement`, `framework-strands-sessions`. Modified: the Claude-only baseline requirements `framework-seam` leaves to `claude` projects, scoped to their framework. The framework option, secrets per framework and the collector per framework land in `framework-seam`. Names settle at finalize.

## Decisions

- **Both frameworks stay, chosen per project by use case:** `claude` for coding, Strands for non-coding (the operator, 2026-10-22).
- **Strands is a framework inside AgentForge's boundary, not a replacement for it.** AgentForge keeps A2A 1.0, the gateway, the executor, the task store and the client. Strands' own A2A server and AgentCore sample are unused.
- **The provider is the Anthropic API directly, with an API key.** Bedrock was rejected for its model-usage-limit approvals and for parity with the API (the operator, 2026-10-22).
- **The budget is the Anthropic Console's monthly spend limit.** A LiteLLM gateway is deferred: its budgets need a PostgreSQL database (the operator, 2026-10-22). If added later, it owns budgeting and request-level caching only. Prompt caching stays the framework's, at block level.
- **The `claude` framework keeps the subscription;** a Strands project bills per use.
- **The Strands Temporal integration is not used** (`@temporalio/strands-agents`, which runs the agent loop in workflow code). It is recorded as §ODO012: the concept is right, but the edge cases are too many today.

## Impact

- `libs/agentforge/src/framework/strands/` grows from the stub into the framework: `harness/`, `server/`, `plugin/`, its `Dockerfile` and `container/`, and whatever else it needs. Shared modules change only where the stub proved the interface short.
- New peers, exact while pre-1.0 or moving weekly: `@strands-agents/sdk`, and possibly `@strands-agents/harness` (Open Questions).
- A new example in `packages/examples/`.
- `docs/ARCHITECTURE.md` §1, §5, §6 and §7; `docs/GLOSSARY.md`; `docs/REQUIREMENTS.md` (§REQ705 withdrawn, §REQ714 added, §REQ404 reworded or scoped); `docs/research/strands-agents.md`.
- The `claude-plugin` skill.

## Dependencies

- **`framework-seam`**, which this change follows, and ADR 0021.
- **§REQ705 withdrawn.** Proposed replacement **§REQ714**: *"Each deployment authenticates to its model provider only with what it declares: the operator's subscription where the framework can use it, otherwise an API key, with spend bounded by the provider account's limit. No credential is present that it did not declare."* The reason for withdrawal: a framework that cannot use the subscription is now wanted.
- **§REQ404** names Claude Code's auto memory (Open Questions).
- ADR 0017 (fragments) and §ODO013 (the preset), ADR 0011 (state through APIs), ADR 0015 (filesystems), ADR 0020 (local store).
- **§ODO005 (a credential broker):** an API key in the task's environment is readable by the agent's shell, as the subscription token is today. The Console's spend limit bounds the exposure.
- **§ODO006 (background work)** applies: it stays off for Strands too.
- **§ODO012:** the Strands Temporal integration.

## Open Questions

1. **The SDK alone, or `@strands-agents/harness` too?**
   - The harness offers the most built-in capability, which is the operator's reason. But it is 0.x, a month old, and breaks on minors. Its defaults (background subagents, an unsandboxed host shell, background memory extraction, AGENTS.md discovery) need overriding to meet AgentForge's rules.
   - The SDK with selected vended tools and plugins (skills, shell and files) gives the same tools under AgentForge's control.
2. **Auto memory (§REQ404) for Strands.** Reword the requirement framework-neutrally and meet it with Strands' `FileMemoryStore` over a mounted memory space? Or keep it `claude`-only and defer?
3. **Layered instructions.** `claude` composes `.claude/` from the base layer and the agent directory. Should Strands compose the layers' instruction files and skills in the same order, and under what directory name?
4. **Structured-output cap.** Which number by default (the Claude CLI's is five)? And is "the first submission in a message counts" acceptable, or should a later valid one in the same message be taken?
5. **The Console's spend limit reached.** Which shared cause is it, once the spike sees what the API answers? `BUDGET_EXHAUSTED` is not retryable; `USAGE_LIMITED` is retryable after a reset, and the limit resets monthly.
6. **The example's shape.** Which non-coding procedure exercises the Strands framework realistically? Does it also cover the run mechanics `smoke-coverage` covers for `claude` (attach, resume, cancel, lost, filesystem), or does a second, smaller example do that?
7. **Does ADR 0017's "fragments, never the preset" rule generalise,** or stay `claude`'s? Strands has no preset.
8. **Bun.** If the spike finds Strands does not run on Bun, does the Strands image's task process run on Node? The server would stay on Bun (the executor spawns `process.execPath`).

## Notes

- **StrategyFoundry.** Its coding directives, `rnd.implement` and the code reviewers, stay on `claude`. Candidates for a Strands project are its non-coding ones: `rnd.evaluate`, `discovery.*`, `strategy.diagnose` and `strategy.postmortem`. Which move is the operator's, in StrategyFoundry.
- **Strands' structured output is looser than §REQ208,** so AgentForge's validation hook and cap carry over as middleware or hooks. Nothing about Strands removes that work.
- **The TS integration for Temporal** (`@temporalio/strands-agents` 1.24.0, Experimental) puts the whole message array into every model activity and the full event stream into its result. That gives history quadratic in run length, and continue-as-new only between invocations. Recorded in §ODO012.
