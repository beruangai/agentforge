# Applying a Change

Project rules for implementing a change, on top of `/opsx:apply` (change selection, context loading, working through tasks, pausing on blockers). Artifacts are directional: implementation validates them against the actual codebase rather than transcribing them.

## Before implementing

- **Read the current state.** For every surface the proposal's Impact names, read the current file or document. The artifacts may have been written against an older snapshot.
- **Trace the flow end to end** before changing how a capability behaves — caller, client, runtime, task process, harness, Agent SDK.
- **Find the single writer.** Identify which component owns each piece of state the change touches, and which only read it.
- **Read `docs/lineage/`** when the change has a predecessor equivalent — it is evidence of what hurt, never a specification.
- **Delegate to subagents** where the change's size earns it — independent surfaces in parallel, one context each.

## Deviation handling

When an assumption in the proposal, design, or specs fails in practice:

1. **Pause.** Do not work around it — a worked-around change archives a record of something that was not built.
2. **Surface the options** — the constraint found, the artifact's original intent, and the trade-offs of each path.
3. **Wait for the operator's decision.**
4. **Update every affected artifact** before committing the implementation.
5. **Re-run `openspec validate --strict "<name>"`.**
6. **Commit the implementation and the artifact updates together.**

A deviation that is a decision earning an ADR is recorded then, as a `proposed` ADR linked from `design.md` (`adr/README.md`).

## Tasks and commits

- A task's checkbox flips in the same commit as the work it represents — never in a separate update.
- `openspec validate --strict` passes before every commit that touches a change.

## Verification

Each new or modified scenario has at least one automated test or operator-runnable check. Run the checks relevant to the surface touched; a full matrix is not a substitute for understanding the change.
