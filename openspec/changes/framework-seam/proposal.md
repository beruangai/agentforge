# Proposal

## Why

The protocols at AgentForge's boundary are already agnostic of the agent SDK: neither the A2A 1.0 wire nor the task-process protocol carries an SDK type. Lint keeps the SDK out of the runtime, the client, core and infra, with two marked exceptions: the S3 session store's type import, and `readTranscript`'s type import and lazy `import()`. The agent loop beneath them is fixed to the Claude Agent SDK, though, and the coupling leaks into the surfaces a consumer writes against:

- A run's options are the SDK's `Options` type.
- A context block's cache breakpoint is an Anthropic SDK type.
- `context.agentOptions` carries Claude Code permission-rule strings, which the filesystems render.
- The required secret, the causes' suggested actions, the CLI's telemetry environment and the one image all assume Claude.

The operator will support more than one **framework**, the agent SDK a project's runs go through. Each is chosen per agentic project for a different use case: the Claude Agent SDK (`claude`) for coding, and later Strands Agents (`strands`) for non-coding work. This is not a migration; both stay ([ADR 0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md), proposed). *Framework* is the term because *harness* already names layer 2, which stays shared. It reverses a documented non-goal: `docs/SOLUTION_SPACE.md` and `docs/ARCHITECTURE.md` §10 list "frameworks other than the Claude Agent SDK" as out of scope.

**Why now:** the consumer-facing move is breaking. StrategyFoundry has one placeholder agent today, so it costs least now, and the cost grows with every procedure the consumer writes. Decoupling now, with `claude` as the default and only framework, makes a second framework additive later, with no refactor in the consumer.

## What Changes

- **Each framework is a self-contained part of the package.** AgentForge's current modules stay the shared base, and each framework holds everything specific to it, its image definition included. Everything Claude-specific moves into the `claude` framework as it is: the run kernel and what it governs, the session store, the options, the Claude-specific cause texts, the CLI's telemetry, and the scaffolds and container peers. Lint keeps shared code out of every framework, except where the plugin reaches each framework's rendering through one registry. It also keeps frameworks out of each other, and keeps the existing layer rules inside each framework.
- **A framework interface in layer 2.** It covers what `runAgent` calls, the oRPC middleware that marshals the mounts into the framework's options, and what declares the framework's required secrets, telemetry and suggested actions.
- **BREAKING — entry points per framework.** `/agent` keeps only the shared surface:
  - filesystems
  - `composeContext` and `ContextBlock`, with a cache breakpoint of AgentForge's own
  - stop guards
  - `TaskFailure`

  The Claude surface moves out of `/agent` and `/client`:
  - `/claude/agent`: procedures — `implementAgent`, `runTaskProcess` and the task context, bound to `claude`;
  - `/claude/server`: what the server entry passes;
  - `/claude/client`: `readTranscript`;
  - `/claude/infra`: the framework's required secrets, for constructs.

  A procedure written for one framework does not compile against another.
- **BREAKING — filesystems state permissions as data.** A mount gives `read` on the whole mount and `edit` on each write glob, globs relative to the mount, instead of Claude rule strings. The filesystem middleware no longer builds `context.agentOptions`. Each framework vends an oRPC middleware, appended after the filesystem mount at the end of every procedure's chain, that marshals the mounts into its own options as `context.agentOptions`. For `claude` that renders the same `additionalDirectories` and `Read`/`Edit` rules as today. It is still never applied unless the procedure composes it (§REQ211).
- **The run record names its framework,** by `framework.name` (`claude`) and `framework.fullName` (the SDK and the version AgentForge pins). It keeps shared token usage every framework reports, and the framework's raw usage, which is also on the run the procedure receives. USD cost stays optional, set only where the framework reports it. Causes keep their names and semantics.
- **Secrets and telemetry are declared by the framework,** not globally. `claude` still requires `CLAUDE_CODE_OAUTH_TOKEN`, and the runtime still starts the collector with what the framework declares.
- **Images:** AgentForge's image becomes a shared base, `agentforge/a2a`, and each framework's image, `agentforge/a2a-claude` here, is built on it with what its SDK needs. The chain is base → framework → agentic → agent.
- **BREAKING for a synced project — the plugin records the framework on the agentic project.** `--framework` takes `claude`, the default and only value. Sync refuses a project that records none, naming the field, and the migration entry says to add it. Rendering comes from the framework's `plugin/` part, reached through one registry.
- **A Strands stub,** a typechecked shell of the interface that throws "not implemented". It keeps the interface from being shaped by Claude alone. It is not registered, not exported, not a plugin option, and depends on no Strands package.
- **The examples, the `claude-plugin` skill and `references/migrations.md`** move to the new imports (§REQ712).

## Capabilities

### New Capabilities
- `harness-framework`: a procedure runs under its project's framework, which derives the run's options from the mounts and names itself on every run's record.

### Modified Capabilities
- `filesystem-lifecycle`: a mount's permissions are given as actions on relative globs, and the run options derived from the mounts move to the framework.
- `plugin-agentic-project`: a project is generated for one framework, and its images build through that framework's image.
- `plugin-agentic-connection`: the secrets an agent's construct requires are the framework's, not AgentForge's.
- `infra-agent-runtime`: a deployed agent's declared secrets include its framework's, not AgentForge's subscription token.

The `harness-kernel-settlement`, `harness-session-persistence`, `harness-context-distillation` and `harness-auto-memory` capabilities keep their requirements unchanged. They describe the `claude` framework's behaviour, which moves without changing. So do `harness-context-composition`'s requirements on content blocks and commands, which become `claude`'s with `/claude/agent`, and the baseline requirements that name Claude configuration, the subscription or Claude Code's read fence: `plugin-agentic-project`'s "Generating an agentic project" and "A generated project fences reads by default", and `plugin-agentic-agent`'s Claude configuration and its serve scenario without the subscription credential. They hold for `claude` projects, the only framework, and `strands-framework` scopes them when a second framework makes them partial. `harness-kernel-settlement`'s "every run is recorded" stays the general rule; `harness-framework` adds what the record says of its framework.

## Impact

- **Interfaces:**
  - The package's export map: `/claude/agent`, `/claude/server`, `/claude/client` and `/claude/infra` added; `/agent` narrowed; `readTranscript` moved off `/client`.
  - The task context's `agentOptions`, typed by the framework.
  - Filesystem permissions as data, and the context block's cache breakpoint.
  - The run record's shape.

  All of them sit where a consumer meets the framework. The A2A contract's calls and the task-process protocol's framing do not change: the seam is inside layer 2, below the protocols. The run record both carry does change — the task-process `record` message and the task's `metadata.runs` — because it now names its framework and keeps usage every framework reports.
- **Code:** `server/harness/` (the Claude parts out, the interface in), `server/harness/filesystem/`, `core/` (the session-store adapter out; the run record; secrets; suggested actions), `server/runtime/` telemetry and collector, `infra/`, `client/`, `plugin/` (the registry, the generated task and server entries, `serve`), the `Dockerfile` and `container/`, `biome.json`, `tsdown.config.ts` and `project.json` (entries, copies, image targets), the `integ/` slices and fixtures that import moved modules, the examples.
- **Docs:**
  - `docs/ARCHITECTURE.md` §1, §3, §5, §6, §7, §8 (entry points, layout) and §10 (no longer "deliberately absent")
  - `docs/SOLUTION_SPACE.md`: what AgentForge is, and out of scope
  - ADR 0001, 0008, 0015 and 0018, mutated in place under the rule in `adr/README.md`. The operator ruled on 2026-10-22 that StrategyFoundry, bootstrapped locally and not yet customised, does not yet depend on them; ADR 0021 records the ruling
  - ADR 0021, proposed, including why the whole seam is built now
  - `openspec/config.yaml`'s `context`, which calls AgentForge a Claude Agent SDK wrapper
  - `docs/GLOSSARY.md`: *framework*, and *kernel*, *agent run*, *AgentForge image*, *agentic image*, *required secrets*
  - the root and package `README.md`

  The orientation sentence of `CLAUDE.md` ("runs a Claude Agent SDK procedure") is the operator's to reword.
- **Requirements:**
  - Serves new §REQ713, proposed for the operator: *a consumer chooses each agentic project's agent framework; its contracts, callers, clients, workflows, filesystems and infrastructure are the same whichever it chooses, and a procedure written for one framework does not compile against another*.
  - Keeps §REQ204 (guardrails compose), §REQ211 (derived options given, never applied) and §REQ601 (every run recorded, its transcript readable).
  - Keeps §REQ705: `claude` still authenticates with the subscription.
  - Leaves §REQ404 Claude-only.
- **Consumers:** StrategyFoundry's `rnd` project follows the migration entry: imports, and `framework: 'claude'` in its project record. A consumer's callers and agents upgrade together: the run record's shape changes, and a task from one version does not parse in a client of the other.
- **Open options:** none depended on. §ODO002, §ODO008 and §ODO013 stay the `claude` framework's, unchanged.

## Non-goals

- A second working framework. Strands is a stub here; `strands-framework` is a later change.
- Choosing a framework per agent, or at run time (ADR 0021).
- Changing any behaviour of the `claude` framework's runs.
- Renaming the `harness-*` capabilities that now describe the `claude` framework.
- A shared base type for framework options. No shared code writes one.
