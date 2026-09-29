---
paths:
  - ./**/openspec/**
---

<OPENSPEC_PROJECT_RULES>
These rules override default OpenSpec protocol behavior. Follow exactly.

## The guides are the source of truth

`openspec/guide/` owns the detail; this file holds only what no guide does, and points at them. `openspec/config.yaml` loads each guide as a rule on the artifact or operation it governs.

| Read before | Guide |
|---|---|
| Authoring or revising a spec delta — capability granularity and naming, the behavior-contract self-check, deltas, citations, scenarios | [`openspec/guide/spec.md`](../../openspec/guide/spec.md) |
| Implementing a change — current state, deviation handling, tasks and commits, verification | [`openspec/guide/apply.md`](../../openspec/guide/apply.md) |
| Drafting a change, finalizing one, or verifying its artifacts | [`openspec/guide/draft-finalize.md`](../../openspec/guide/draft-finalize.md) |

## Document Scope

**proposal.md** = Problem/solution space only.
- Why, what changes, decisions, impact, success criteria
- NO implementation code, NO file-level details
- Tables and examples for clarity, not implementation

**design.md** = Implementation guidance, not prescription.
- Mark as guidance: "Adapt to actual constraints"
- Pseudo-code and conceptual patterns, not copy/paste code
- Resolve all open questions before finalizing (no "TBD" or unresolved Q's)

**tasks.md** = Ordered implementation checklist.
- Small, verifiable work items
- Note dependencies and parallelization opportunities

## Iterating before the artifacts are fixed

A change whose shape is not yet settled is a draft — `schema: draft`, one `draft.md`, not implementable — and `/opsxx:finalize` authors the artifacts from it in one pass ([`draft-finalize.md`](../../openspec/guide/draft-finalize.md)). Do not iterate a proposal by rewriting downstream artifacts on every turn; the `spec-driven` order is proposal → specs → design → tasks, and specs come before design.

## Terminology

Unify naming across all docs. If CLI uses `<agent> <command>`, use it everywhere—not `<group> <action>` in one place and `[agent] [action]` in another.

## Archiving

Finalize the deltas before `openspec archive <id>` — the MODIFIED re-examination in [`spec.md`](../../openspec/guide/spec.md) § Deltas — then run the standard flow.

</OPENSPEC_PROJECT_RULES>
