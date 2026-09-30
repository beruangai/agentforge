# Architecture Decision Records

Decisions worth keeping the reasoning for, in [MADR 4.0.0](https://adr.github.io/madr/) format.

- **An ADR records a decision, not a history.** The options weighed, the one chosen, what it costs. A previous implementation is context at most, never the subject.
- **The owning document states the outcome** — [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for structure, [`docs/GLOSSARY.md`](../docs/GLOSSARY.md) for terms — and links here rather than restating the reasoning.
- **[`docs/DESIGN_OPTIONS.md`](../docs/DESIGN_OPTIONS.md) is the drafting log.** A question decided there moves to the owning document, and earns an ADR when a future reader would plausibly propose the rejected option again.
- **A decision that stops being relevant is dropped**, not kept as a record of a road not taken.
- **Until a consumer depends on it, an accepted ADR is mutated in place** when its reasoning stops holding — nothing outside this repository has to migrate, and the operator's standing rule is to get it right now. 0002, 0003, 0004, 0006, 0008, 0009 and 0013 were brought in line with the A1 implementation on 2026-09-25. Once a consumer depends on one, a replaced decision is *superseded*: the old ADR stays, marked, and is never edited into agreement with its replacement.
- **A new ADR is written `proposed`** and becomes `accepted` only when the operator accepts it. Never write one as accepted yourself, and never treat a proposed one as settled — raise it.
- **0001–0011 were accepted by the operator on 2026-09-21, 0012–0014 on 2026-09-22, and 0015 on 2026-09-29.** Each ADR's own `date` is when its decision was made, which is not always when it was first written: 0003 and 0013 were re-decided on 2026-09-22 and rewritten in place.
- **Numbers are stable ids.** 0005 was dropped when its decision — that the executor is agnostic of what a task runs — became a consequence of 0001 and 0004 rather than a choice.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-four-layers-with-contracts-at-the-boundaries.md) | Four layers, with a contract at every boundary | accepted |
| [0002](0002-a2a-is-the-boundary-contract.md) | A2A is the contract between caller and runtime | accepted |
| [0003](0003-procedures-are-type-safe-end-to-end.md) | Procedures are type-safe end to end | accepted |
| [0004](0004-a-process-per-task.md) | A process per task, over Node IPC | accepted |
| [0006](0006-task-state-is-durable-outside-the-session.md) | Task state is durable outside the runtime session | accepted |
| [0007](0007-identity-is-the-consumers.md) | Identity and isolation are the consumer's | accepted |
| [0008](0008-code-ships-in-the-image.md) | Code ships in the image, and images layer | accepted |
| [0009](0009-the-caller-supplies-the-idempotency-key.md) | The caller supplies the idempotency key; a task id is a wire handle | accepted |
| [0010](0010-agentforge-is-consumed-as-an-nx-plugin.md) | AgentForge is consumed as an Nx plugin, and agents nest in one project | accepted |
| [0011](0011-state-persists-through-apis-not-mounts.md) | State persists through APIs, not mounts | accepted |
| [0012](0012-the-server-is-assembled-not-inherited.md) | The A2A server is assembled from `@a2a-js/sdk`, not inherited from the AgentCore SDK | accepted |
| [0013](0013-a-procedure-is-an-orpc-contract.md) | A procedure is an oRPC contract, split into A2A's own task calls | accepted |
| [0014](0014-agentforge-speaks-a2a-1-0-only.md) | AgentForge speaks A2A 1.0 only | accepted |
| [0015](0015-filesystems-mount-around-a-procedure.md) | Filesystems mount around a procedure; S3 syncs with `s7cmd` | accepted |
| [0016](0016-a-workflow-project-is-a-generated-caller.md) | A workflow project is a generated caller | proposed |
