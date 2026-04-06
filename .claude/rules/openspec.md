---
paths:
  - ./**/openspec/**
---

<OPENSPEC_PROJECT_RULES>
These rules override default OpenSpec protocol behavior. Follow exactly.

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

## Drafting Proposals

When drafting a proposal, only generate `proposal.md` and `design.md` until user agrees and confirms. Then finalize the `proposal.md` and `design.md`, generated the specs changes (`openspec/change/{change}/specs/*`), then generate the `tasks.md`.

This prevent wasted cycles during proposal and design iterations before finalized.

## Terminology

Unify naming across all docs. If CLI uses `<agent> <command>`, use it everywhere—not `<group> <action>` in one place and `[agent] [action]` in another.

## Spec Naming

**Prefix specs with package name.** Since OpenSpec doesn't support namespaced/nested specs, prefix capability names with the owning package for readability and separation of concern:
- `claude-sandbox-execution`, not `execution`
- `mcp-gateway-routing`, not `routing`

## Spec Content

**Requirements-focused, not implementation-mirroring.** Specs define WHAT the system must do, not HOW it's built. Implementation details should be able to drift without breaking spec-level requirements:
- Specify observable behaviors, inputs, outputs, and constraints
- Avoid referencing internal file names, class names, or module structure
- Use scenarios that test from the consumer/boundary perspective
- Implementation-level concerns belong in design.md, not specs

## Spec Granularity

**Merge aggressively to minimal separate specs.** Each spec should cover a meaningful behavioral surface area, not mirror internal modules. Fewer, broader specs are preferred over many fine-grained ones.

## Spec Deltas

**Prefer REMOVED/ADDED over MODIFIED.** MODIFIED requires full copy/paste replacement of entire requirement. For most changes, surgical REMOVED/ADDED pairs are more concise and maintainable:

- Changing a scenario? REMOVED old scenario, ADDED new scenario
- Adding scenarios to existing requirement? Just ADDED (no MODIFIED needed)
- Rewriting entire requirement? Then MODIFIED is appropriate

**MODIFIED is rarely correct.** If keeping most scenarios unchanged, use REMOVED/ADDED pairs instead.

## Archiving

**Pre-archive: finalize deltas.** Before `openspec archive <id>`:

1. Read source-of-truth specs being changed
2. Evaluate each MODIFIED—should it be REMOVED/ADDED pairs instead?
3. If keeping MODIFIED, ensure it's complete replacement (merge intent with existing)
4. Then run standard `openspec archive <id>` flow

## Applying Proposals

design.md is directional—validate against actual codebase before implementing. Trace execution flow first. Establish ownership (who computes/sets state vs. who reads).

Use efficient and effective delegate via subagents and agent teams depending on proposal implementation complexity.

</OPENSPEC_PROJECT_RULES>
