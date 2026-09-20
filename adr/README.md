# Architecture Decision Records

Decisions worth keeping the reasoning for, in [MADR 4.0.0](https://adr.github.io/madr/) format.

- **An ADR records a decision, not a history.** The options weighed, the one chosen, what it costs. A previous implementation is context at most, never the subject.
- **The owning document states the outcome** — [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for structure, [`docs/GLOSSARY.md`](../docs/GLOSSARY.md) for terms — and links here rather than restating the reasoning.
- **[`docs/DESIGN_OPTIONS.md`](../docs/DESIGN_OPTIONS.md) is the drafting log.** A question decided there moves to the owning document, and earns an ADR when a future reader would plausibly propose the rejected option again.
- **A decision that stops being relevant is dropped**, not kept as a record of a road not taken. A decision that is *replaced* is superseded: the old ADR stays, marked, and is never edited into agreement with its replacement.
- **Every ADR here is `proposed`** until the operator accepts it. Never write one as `accepted`, and never treat a proposed one as settled — raise it.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-four-layers-with-contracts-at-the-boundaries.md) | Four layers, with a contract at every boundary | proposed |
| [0002](0002-a2a-is-the-boundary-contract.md) | A2A is the contract between caller and runtime | proposed |
| [0003](0003-procedures-are-type-safe-end-to-end.md) | Procedures are type-safe end to end | proposed |
| [0004](0004-a-process-per-task.md) | A process per task, speaking JSON-RPC over a pipe | proposed |

Numbers are stable ids; 0005 was dropped when its decision — that the executor is agnostic of what a task runs — became a consequence of 0001 and 0004 rather than a choice.

| [0006](0006-task-state-is-durable-outside-the-session.md) | Task state is durable outside the runtime session | proposed |
| [0007](0007-identity-is-the-consumers.md) | Identity and isolation are the consumer's | proposed |
| [0008](0008-procedure-code-is-a-published-bundle.md) | Procedure code is a published bundle, not a baked image | proposed |
| [0009](0009-the-caller-supplies-the-idempotency-key.md) | The caller supplies the idempotency key; a task id is a wire handle | proposed |
| [0010](0010-agentforge-is-consumed-as-an-nx-plugin.md) | AgentForge is consumed as an Nx plugin, and agents nest in one project | proposed |
