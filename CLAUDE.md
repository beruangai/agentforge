# Claude Code Orientation

**AgentForge** is a procedure wrapper for the Claude Agent SDK, built for its consumers — StrategyFoundry and TrendBot — not for public use. Consumers declare procedures; AgentForge runs each as an asynchronous task over A2A, on Bedrock AgentCore Runtime or locally in Docker, and returns a typed, validated outcome. It is delivered as an Nx plugin: generators, CDK constructs, a base image, and a caller-agnostic client with a Temporal activity factory over it.

No implementation yet. **The [ADRs](adr/README.md) were accepted on 2026-09-21 and the architecture rests on them** — reversing one is a superseding ADR, not an edit. A new decision is still written `proposed` until the operator accepts it, and everything in `docs/DESIGN_OPTIONS.md` is open.

## Read first

1. [`README.md`](README.md)
2. [`docs/SOLUTION_SPACE.md`](docs/SOLUTION_SPACE.md) — the problem and the scope
3. [`docs/CONSUMERS.md`](docs/CONSUMERS.md), **then both consumer contracts it points to** — the specification this workspace answers to:
   - `~/workspace/beruangai/StrategyFoundry/docs/AGENTFORGE_CONTRACT.md`
   - `~/workspace/PlayTek/trendbot-monorepo/docs/AGENTFORGE_CONTRACT.md`
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the layers, the contract at each boundary, procedures, tasks, runtime, harness
5. [`docs/DESIGN_OPTIONS.md`](docs/DESIGN_OPTIONS.md) — **what is not decided**, and the spikes that decide it
6. [`adr/`](adr/README.md) — **read the relevant ADR before proposing to reverse a direction**
7. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — canonical terms

Before relying on platform behavior, [`docs/research/`](docs/research/) — verified facts about AgentCore, A2A, and the Agent SDK, each with the date it was read. [`docs/lineage/`](docs/lineage/) is evidence from the first AgentForge, never a specification.

## Premise

Settled by the operator: consumers own the requirements; invocation is asynchronous; authentication is the operator's Claude Max subscription, used as intended — not a topic to reopen. The rest is the working direction, proposed.

**Consumers define the requirements; AgentForge owns the decisions.** A consumer states behavior it depends on, at the contract, in its own repository. AgentForge derives its requirements from theirs and decides everything about meeting them. A requirement only one consumer has is met by configuration or by a helper it calls — never by a branch in the harness or the runtime. A consumer contract is an unvetted draft: where a requirement states a mechanism, or asks for something AgentForge cannot meet, raise it rather than building it. A conflict between consumers is raised, not resolved silently.

**Four layers, with a contract at every boundary.** Runtime, harness, consumer, SDK. Layers 1 and 2 never import each other; they share only the task protocol. Each layer is testable alone, and a failure is fixed in the layer that owns it.

**The caller is outside the boundary.** The client is caller-agnostic and the Temporal activity factory sits over it. Nothing below the client knows a caller exists, and Temporal is never a dependency of the runtime or the harness.

**The consumer owns isolation and side effects.** How runtime sessions, A2A contexts, Claude sessions and working directories relate is the consumer's, and may differ per procedure. AgentForge propagates them and enforces only mechanical invariants. A side effect's recovery is the consumer's too.

**Settle platform behavior by testing it.** Where a question turns on what AgentCore, A2A's SDK, S3 Files, or the Agent SDK actually does, a spike against the real thing answers it — not documentation, not a search summary, not what the first AgentForge assumed.

**Every intermittent failure becomes a test.** Reproduce it once, in the layer that owns it, and keep it covered.

## Conventions

The operator's standing conventions across projects:

- **Organize by scope, never by type.** Nx grouped layout on `@aws/nx-plugin` defaults: thin deployables in `apps/{scope}/{deployable}`, the code they run in `libs/{scope}/{capability}`. A capability owns its code, schemas, and tests together; file names carry the type. Never a `schemas/`, `types/`, or `utils/` tree collecting one kind across scopes.
- **Verbose, unambiguous names.** `timestamp`, not `ts`; `configuration`, not `cfg`.
- **Borrow terms before inventing them** — the Agent SDK's, AgentCore's, or A2A's first, then this glossary's, then a new one. No consumer's domain vocabulary.
- **Binary state is a boolean.** An enum only where a third state is genuinely foreseeable, and its values are `SCREAMING_SNAKE_CASE`.
- **One published package.** AgentForge vends `@beruangai/agentforge` with entry points per environment; internal libraries are never published on their own.
- **uuid7 for every id AgentForge mints.** Never uuid4. Ids minted by a dependency are opaque and not reformatted.
- **Zero silent failures.** Throw and handle. No empty-result fallbacks, no swallowed exceptions, no defaults papering over missing data, no option accepted and dropped.
- **No legacy support.** Latest stable toolchain; no shims or compatibility bridges.
- **Minimal public surface.** Expose what consumers need; nothing internal leaks.
- **Seams, not speculative abstractions.** An interface earns its place when a second implementation exists or two consumers need different ones.
- **TypeScript on Bun.**

## Working rules

- **A new ADR is written `proposed`** and the operator accepts it. Never write one as `accepted` yourself, and never treat a proposed one as settled.
- **An ADR records a decision, not a history.** A decision that stops being relevant is dropped; one that is replaced is superseded and marked.
- **Consumer contracts are read, never edited here.** Raise anything unclear or conflicting with the operator, in that consumer's repository.
- **[OPEN §x] means undecided.** Do not implement against an open section, and do not resolve one silently. Raise it, or use `AskUserQuestion`.
- **Ask over assume.** The operator co-authors design decisions.
- **Never pivot requirements to fix an issue.** If something is stuck, stop and say so.
- **Complete means done to the fullness of the spec.** Report what was skipped and why.
- **Decisions live where they are owned.** Structure in `ARCHITECTURE.md`, terms in `GLOSSARY.md`, reasoning in a short MADR ADR written when the decision is made, open questions in `DESIGN_OPTIONS.md`, verified platform facts in `docs/research/` with their date.
- **Design documents stop above the detail.** Exact signatures, schemas, and thresholds are settled in a capability's proposal; sketches illustrate shape.

## Spec-driven development

Non-trivial changes go through OpenSpec (proposal → specs → design → tasks, then verification). Behavior contracts go in `openspec/specs/`, created when the first change is synced; in-flight work in `openspec/changes/`. Rules in [`openspec/config.yaml`](openspec/config.yaml) and `.claude/rules/openspec.md`. OpenSpec artifacts are `docs` scope in Conventional Commits.

## Related codebases

- **The first AgentForge**, in `~/workspace/PlayTek/trendbot-monorepo/packages/agentforge`, runs TrendBot today. Evidence of what hurt, never a specification ([lineage](docs/lineage/first-agentforge.md)). Port with review; never copy its shape. TrendBot's own drafts are rough; do not take them as fact.
- **`a2a-claude`, `claude-a2a` and `temporal-agent-harness`** wrap an agent SDK behind a protocol boundary. None is a dependency or a model; [`docs/research/harness-references.md`](docs/research/harness-references.md) records the mechanics worth borrowing from each, and why each differs.
- **`@aws/nx-plugin`** is the convention AgentForge's own plugin follows; its `ts#agent` generator is built for Strands and is a reference, not a base ([ADR 0010](adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)).
- **This workspace's April 2026 packages and research** are gone from the tree; their archived OpenSpec changes remain under `openspec/changes/archive/` as history.
