---
name: 'OPSXX: Verify Proposal'
description: Independent, grounded review of a finalized change's artifacts for correctness, completeness, cohesion, and simplification
argument-hint: '<name> [additional context]'
category: Workflow
tags: [workflow, verify, review]
---

Independent review of a finalized change — proposal, specs, design, tasks — against itself and against the project state it will land into. The counterpart to `/opsx:verify`, which checks an implementation against its artifacts; this checks the artifacts.

**Grounding is load-bearing.** A change can be internally consistent and structurally valid yet still wrong — against a project principle in `CLAUDE.md` or `.claude/rules/`, an accepted ADR, an open design option, the current source, or another change in flight. Review against the reconstructed baseline, not the artifacts alone.

**Independence is load-bearing.** No output is self-certified. Re-read every artifact from disk; a generator's summary is not evidence.

**Input**: `<name> [additional context]`. Context narrows emphasis — a surface, an assumed landing order — and never skips a dimension or an axis. If `<name>` is missing or ambiguous, ask with **AskUserQuestion**.

**Steps**

0. **Ensure a fresh context.** If this conversation authored or edited any artifact of `<name>`, do not review here: spawn a fresh agent (Agent tool) to run `/opsxx:verify-proposal <name> [additional context]` and relay its report verbatim.

1. **Refuse a draft.** If `.openspec.yaml` has `schema: draft`, STOP: "`<name>` is a draft and is not verifiable. Run `/opsxx:finalize <name>` first." If `draft.md` still exists in a non-draft change, STOP: finalize did not complete.

2. **Structural validation.**

   ```bash
   openspec validate --strict "<name>"
   ```

   On failure, STOP and report; grounded review of a structurally invalid change is wasted.

3. **Load the change.** `proposal.md`, `specs/**/*.md`, `design.md`, `tasks.md`, and every ADR the change links.

4. **Reconstruct the baseline.**
   - a. **Project rules** — `CLAUDE.md` and `.claude/rules/` (principles, conventions, guardrails), `docs/SOLUTION_SPACE.md`, `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md`, `docs/GLOSSARY.md`, `openspec/guide/`.
   - b. **Decisions** — `adr/README.md` and every in-force ADR relevant to the surfaces touched; `docs/DESIGN_OPTIONS.md` for open options (§ODO###).
   - c. **Deliberate non-goals** — the out-of-scope sections of `docs/SOLUTION_SPACE.md`, the unmet requirements of `docs/REQUIREMENTS.md`, and `docs/lineage/` where the change has a predecessor equivalent (evidence, never a specification).
   - d. **Current source** for every file or project the change names. An unconfirmed claim about the code is a correctness risk, not a detail.
   - e. **Spec baseline** — for each modified capability, `openspec show "<capability>" --type spec`. Deltas must resolve against it.
   - f. **In-flight changes** — `openspec list --json`. For each change that this one names, that names this one, or that touches a shared capability, document, or ADR number, read its artifacts (for a draft, `draft.md`). Confirm declared dependencies exist and define what is claimed.
   - g. **Authoring rules** — for each artifact, `openspec instructions <artifact> --change "<name>" --json`. Every entry in `rules` is a constraint the artifact is checked against.

5. **Review four dimensions, each on two axes:** `[internal]` is artifact against artifact; `[grounded]` is artifact against baseline.

   **Correctness**
   - [internal] Every decision in `design.md` is reflected in a spec delta or a task; none is dropped.
   - [internal] ADDED, MODIFIED, REMOVED, and RENAMED entries resolve against the baseline.
   - [internal] Behavior-contract audit: run the self-check and grep from `openspec/guide/spec.md` over `specs/`. Leaked implementation detail is CRITICAL.
   - [internal] Every task traces to a proposal commitment or design decision; Impact agrees with tasks and deltas.
   - [grounded] Claims about current source and documents match the files. A stale claim is CRITICAL.
   - [grounded] No contradiction of an accepted ADR without a superseding ADR. CRITICAL.
   - [grounded] No open design option (§ODO###) resolved silently. CRITICAL.
   - [grounded] The principles, conventions and guardrails in `CLAUDE.md` and `.claude/rules/` hold. A violated written rule is CRITICAL; a departure from an established but unwritten pattern is WARNING.
   - [grounded] Every capability the change introduces is asked for by a requirement (§REQ###); a need only one consumer has is met by configuration or a helper it calls, never a branch below the boundary. Otherwise CRITICAL.

   **Completeness**
   - [internal] Every What Changes item has tasks; every declared capability has a delta; every validation criterion has a task that makes it verifiable.
   - [internal] Every decision in `design.md` that earns an ADR (`adr/README.md`) links a `proposed` ADR. A missing one is CRITICAL.
   - [internal] Open Questions in `design.md` are genuinely deferrable. One that would change the specs, the approach, or the tasks is CRITICAL.
   - [grounded] Landing order against in-flight changes is stated where it matters; reverse dependencies are met.
   - [grounded] No ADR number collides with one claimed by another in-flight change. CRITICAL.

   **Cohesion**
   - [internal] Artifacts do not contradict each other; the same thing carries the same name throughout.
   - [internal] Each artifact holds only what it owns — why and what in the proposal, decisions in design, work in tasks, behavior in specs. Restated content is WARNING; the fix is to move it, not delete it.
   - [internal] No scope beyond the proposal's commitments; cross-references to other changes resolve.
   - [grounded] Terms follow `docs/GLOSSARY.md` and borrow before inventing; names are verbose and unambiguous.
   - [grounded] New shapes fit sibling shapes on the same surface; paths follow the project's layout convention — a concept owns its code, schemas and tests — never a by-type tree.
   - [grounded] In-flight changes touching the same capability or document either coordinate explicitly or cannot conflict. Silent overlap is CRITICAL, flagged on both.

   **Simplification** — attempt at least one reframing before accepting the proposed approach as minimal. "No simpler way found" counts only after a genuine attempt.
   - [internal] No new mechanism — layer, option, abstraction, capability — without a stated reason a smaller change will not do.
   - [internal] No premature generalization, and no single-versus-multi branching; everything is a bundle.
   - [grounded] Could the change remove code, reuse an existing shape, or move the concern to another layer? A credible simpler alternative goes on the record with its trade-off.
   - [grounded] An interface, layer or option earns its place with a second implementation or a caller that needs it; a seam added on speculation is WARNING, as is code added only to satisfy a principle.
   - [grounded] A guard against a risk whose trigger has not occurred — a deferred option in `docs/DESIGN_OPTIONS.md`, an unmet requirement — is WARNING; prevention comes only on evidence.
   - [grounded] Reinventing a shape, utility, or pattern that already exists is CRITICAL.

6. **Classify findings** as `CRITICAL`, `WARNING`, or `SUGGESTION`, tagged `[internal]` or `[grounded]`. Each names its location — artifact and section, or file, rule, ADR, or sibling change — and a concrete fix.
   - **CRITICAL** — structural invalidity, a dropped decision, a delta that does not resolve, a stale claim, a violated written rule, an unrecorded ADR, a silent pipeline conflict, reinvention.
   - **WARNING** — terminology drift, misplaced content, an undeclared ordering assumption that probably holds, an unjustified mechanism, a credible simpler framing not considered, a pre-emptive guard.
   - **SUGGESTION** — clarity and minor simplification.

7. **Report.**

   ```
   ## Verify Proposal Report: <name>

   ### Structural validation
   `openspec validate --strict <name>` — passed / failed

   ### Grounding baseline
   - Documents and ADRs read: [list]
   - Source files confirmed: [N]
   - In-flight changes considered: [list, with dependencies declared or discovered]

   ### Summary
   | Dimension      | Internal | Grounded |
   |----------------|----------|----------|
   | Correctness    |          |          |
   | Completeness   |          |          |
   | Cohesion       |          |          |
   | Simplification |          |          |

   ### Findings
   [by severity, each tagged, with location and fix]

   ### Verdict
   - `approved` — no CRITICAL, no WARNING
   - `approved-with-notes` — no CRITICAL; WARNING or SUGGESTION present
   - `changes-requested` — one or more CRITICAL
   ```

**Guardrails**

- Review only — do not modify artifacts.
- Do not commit or push.
- If a needed file cannot be read, report "grounding skipped for <file>: <reason>" as a WARNING. Never skip grounding silently.
- Where current source conflicts with an in-flight change that lands first, that change's future state wins; note it.
