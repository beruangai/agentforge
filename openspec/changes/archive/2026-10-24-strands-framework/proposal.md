# Proposal

## Why

`framework-seam` lets an agentic project choose its framework, with `claude` the only one ([ADR 0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md), §REQ713). On 2026-10-22 the operator decided to add **Strands Agents** (`strands`) beside it. Both stay, for different use cases:

- **`claude` for coding.** Claude Code's file editing, Bash and search are what an agentic coding task needs.
- **`strands` for non-coding work,** in separate agentic projects in the same solution.

A project's guardrails, hooks and tools are its framework's, and none of them carries across, which is why the choice is per project.

**The reason is lower-level control of the agent loop:** less magic, more built in. Much of the `claude` framework manages Agent SDK and Claude Code semantics: the kernel's settlement and classification, the structured-output hook, `.claude/` layering, auto memory, the `SessionStore` mirror check, and the CLI's remapped telemetry. Strands' loop is a library AgentForge drives in-process. It has native OpenTelemetry `gen_ai.*` spans, middleware around the model and tool stages, interventions with Cedar authorisation per tool call, and S3 storage for sessions, memory and offloaded tool results. It needs no CLI subprocess, where each Claude task's CLI costs about 165 MB.

**The model stays Anthropic's Claude, through the Anthropic API directly,** for parity with the API. Bedrock was ruled out for its model-usage-limit approvals and its lag behind the API. Strands cannot use the operator's subscription, so a Strands project bills per use with an API key, **bounded by the Anthropic Console's monthly spend limit.**

## What Changes

- **A spike first**, recorded dated in `docs/research/strands-agents.md` before any surface is fixed. It settles:
  - running under Bun, Cedar's wasm included;
  - the SDK's full peer set, and an `@anthropic-ai/sdk` version that `claude` and `strands` share in one workspace;
  - S3 storage against the local store;
  - cache points and structured-output settlement;
  - cancel latency and the file tool's write scope;
  - the layers' instruction directory;
  - the API's answer at the spend limit.
- **The `strands` framework behind the seam,** replacing the stub in `src/framework/strands/`. It is registered and provided, with entry points `/strands/agent`, `/strands/server`, `/strands/infra` and `/strands/client`, whose `readSession` reads a recorded run's session back, as `claude`'s `readTranscript` does. It is built on `@strands-agents/sdk` with selected vended tools and plugins, not `@strands-agents/harness` ([ADR 0023](../../../adr/0023-strands-runs-on-its-sdk-not-its-harness.md), proposed). Its runner drives a Strands `Agent` on the Anthropic provider and keeps every rule the `claude` kernel keeps:
  - one outcome, with no background work (§REQ206);
  - in-turn validation against the agent contract and every stop guard, with a cap AgentForge enforces, since Strands has none (§REQ208);
  - cancel (§REQ304);
  - classification from fields (§REQ501), with the spend limit as `BUDGET_EXHAUSTED`;
  - fail closed: an MCP server that does not start fails the run (§REQ201);
  - the run record, with no USD cost (§REQ601).
- **Filesystems.** The shared lifecycle is unchanged. The framework's middleware renders the mounts' permissions into Strands options. The file tool's write scope is enforced by a Cedar authorisation intervention, and each mount is a working directory of the file and shell tools. What a shell command writes is bounded by the procedure's own allow list, as for `claude`'s Bash.
- **Sessions, memory and offloaded tool results** persist through Strands' S3 storage in the project's session bucket, under the agent's name, and resume in any of the agent's containers (§REQ402).
- **§REQ404 is reworded to be framework-neutral.** A run that declares memory keeps it across tasks, and one that declares none keeps none. `claude` keeps meeting it with Claude Code's auto memory, unchanged; `strands` meets it with Strands' memory in that same storage.
- **Context and prompts.** `composeContext` renders to Strands content, and a cache breakpoint becomes a block-level cache point (§REQ210). AgentForge's system-prompt fragments are appended after the procedure's own, as for `claude`. The layers' instructions and skills compose base first, then agent, under Strands' own directory and file names. `distill` is the framework's own utility run (§REQ209).
- **Credentials.** §REQ705 is withdrawn and replaced by §REQ714. A Strands project's framework requires `ANTHROPIC_API_KEY`, passed and mapped as the OAuth token is for `claude`.
- **Telemetry** (§REQ602). Strands' spans go through the collector with no remapping, under a collector configuration of the framework's own.
- **The image.** `agentforge/a2a-strands` is built on the base `agentforge/a2a`, with no Claude binary.
- **The plugin.** `agentic-project --framework strands` renders the project from `framework/strands/plugin/`. `agent` and sync follow the project's framework.
- **Two examples,** generated by the plugin (§REQ709): a realistic non-coding project, and `strands-smoke`. `strands-smoke` covers what the framework touches: a resume in another container, a cancel mid-tool, and a filesystem across containers. Attach, `LOST` and the Temporal activity are the runtime's and the client's, below the seam, and `smoke-coverage` already proves them. Both are verified end to end locally and on AgentCore against a real model.
- **Guidance.** The `claude-plugin` skill covers choosing, implementing and running a Strands project (§REQ712).

## Capabilities

### New Capabilities
- `framework-strands`: a project's runs go through Strands Agents on the Anthropic API, under the settlement, sessions, memory, write-scope and credential rules a `strands` project relies on.

### Modified Capabilities
- `harness-auto-memory`: its four requirements are scoped to `claude` runs; the memory `strands` keeps is in `framework-strands`.
- `harness-kernel-settlement`: "A failed run carries a typed cause" names the provider's usage or rate limit, the subscription's for `claude`.
- `harness-context-composition`: content as a command's context is `claude`'s, since commands are.
- `harness-session-persistence`: a procedure's own session store is `claude`'s.
- `plugin-agentic-project`: "Generating an agentic project" and "A generated project fences reads by default" are scoped to `claude` projects.
- `plugin-agentic-agent`: an agent's own configuration and serving's absent credential are its framework's, not Claude's.

Beyond those scoped parts, `harness-kernel-settlement`, `harness-session-persistence`, `harness-context-composition`, `harness-context-distillation` and `runtime-observability` hold for every framework, and a `strands` project meets them. `framework-strands` adds only what is specific to Strands. Its deltas land after `framework-seam`'s, whose `harness-framework` it cites.

## Impact

- **Interfaces:** new export subpaths `/strands/agent`, `/strands/server` and `/strands/infra` and `/strands/client`; `FRAMEWORK_NAMES` gains `strands`; the plugin's `--framework` enum gains `strands`. The shared framework interface from `framework-seam` changes only where Strands proves it short.
- **Code:** `libs/agentforge/src/framework/strands/` grows into `core/`, `harness/`, `server/`, `infra/`, `plugin/`, its `Dockerfile` and `container/`.
- **Dependencies:** `@strands-agents/sdk` at a caret range, as a stable package; `container-lock-strands` pins the tested version in the image. Its own peers come with it, as the spike settles them: `@modelcontextprotocol/client` and `@opentelemetry/api` (required), and `@anthropic-ai/sdk`, `@aws-sdk/client-s3`, `@cedar-policy/cedar-wasm` and the OpenTelemetry exporters (optional, used here). It peers `@anthropic-ai/sdk` at `^0.109.1` while `claude` pins `0.128.0`. If no version serves both, the work stops for the operator. No `@strands-agents/harness`.
- **Examples:** two new projects in `packages/examples/`, with their infra and e2e.
- **Documents:**
  - `docs/REQUIREMENTS.md`: §REQ705 withdrawn, §REQ714 added, §REQ404 reworded;
  - `docs/SOLUTION_SPACE.md`'s authentication assumption;
  - `docs/ARCHITECTURE.md` §1, §5, §6, §7 and §8;
  - `docs/GLOSSARY.md`, with *memory space* made framework-neutral;
  - `docs/research/strands-agents.md`;
  - ADR 0011 extended; [ADR 0022](../../../adr/0022-a-framework-that-cannot-use-the-subscription-uses-an-api-key.md) and [ADR 0023](../../../adr/0023-strands-runs-on-its-sdk-not-its-harness.md), both proposed;
  - the `claude-plugin` skill;
  - the orientation and premise in `CLAUDE.md`, which the operator rewords.
- **Requirements served:** §REQ713, §REQ714, §REQ206, §REQ208, §REQ304, §REQ501, §REQ201, §REQ601, §REQ602, §REQ402, §REQ404, §REQ209, §REQ210, §REQ709, §REQ712. None is left unmet for a `strands` project, except where Non-goals say so.
- **Design options:**
  - §ODO006 (background work): it stays off for `strands` too.
  - §ODO005 (a credential broker): its trigger, a key beyond the subscription, fires here. An API key in the task's environment is readable by the agent's shell, as the subscription token is, and the spend limit bounds the exposure. The operator defers it with a new trigger, or settles it.
  - §ODO012 (Strands in Temporal): untouched, since a Strands project runs as a task like any other.
  - §ODO013 (the `claude_code` preset): `claude`'s, untouched.

## Non-goals

- **Replacing `claude`,** or moving a coding procedure to Strands.
- **Bedrock, other model providers, or a gateway.** A LiteLLM gateway is deferred, because its budgets need a PostgreSQL database.
- **Strands' own A2A server or its AgentCore sample.** AgentForge's A2A 1.0 runtime stays the boundary, and Strands is only the loop inside a task.
- **The Strands Temporal integration** (§ODO012).
- **`@strands-agents/harness`.**
- **A read fence for Strands** like Claude Code's. Strands' reads follow its tools and the Cedar policy.
- **Sharing a Strands memory space across agents.** A space is the agent's own, under its name.
