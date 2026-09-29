---
name: 'OPSXX: Finalize'
description: Finalize a draft — convert it to spec-driven, author its artifacts from draft.md, validate, and verify independently
argument-hint: '<name> [additional context]'
category: Workflow
tags: [workflow, artifacts, finalize]
---

Convert a draft change to the `spec-driven` schema and author its artifacts from `draft.md`: triage open questions, switch the schema, generate proposal → specs → design → tasks with `/opsx:continue`, migrate every piece of the draft to the artifact that owns it, delete `draft.md`, validate, and run an independent `/opsxx:verify-proposal`.

Rationale and invariants: `openspec/guide/draft-finalize.md`.

**Input**: `<name> [additional context]`. Additional context may resolve open questions or narrow emphasis; it never widens scope silently. If `<name>` is missing, list changes whose `.openspec.yaml` has `schema: draft` and choose with **AskUserQuestion**.

**Steps**

1. **Refuse a non-draft.** Read `openspec/changes/<name>/.openspec.yaml`. If `schema` is not `draft`, STOP: "`<name>` is not a draft. Use `/opsx:continue` for a change already on a delivery schema."

2. **Read the draft and its baseline.**
   - `draft.md` and any supporting files beside it.
   - Each candidate modified capability: `openspec show "<capability>" --type spec`.
   - Every ADR, `docs/DESIGN_OPTIONS.md` section, and sibling change the draft names.

3. **Triage every open question.** Each becomes exactly one of:
   - (a) **Answered now** — from additional context, the baseline, or a documented project rule. Fold the answer into the draft.
   - (b) **Design-time decision** — earmark for `design.md` Decisions.
   - (c) **Resolves as work** — earmark as a task with a verifiable outcome.
   - (d) **Ambiguous** — ask with **AskUserQuestion**. Never pick silently.

   A question that would resolve an open design option (§ODO###) is always (d). If the draft is too thin to finalize — scope undefined, key decisions missing — ask before generating anything.

4. **Switch the schema.** Edit `.openspec.yaml`:
   - `schema: draft` → `schema: spec-driven`
   - Remove `skip_specs: true` unless the change genuinely makes no spec-level behavior change (pure tooling or docs). If unsure, ask.

   Confirm with `openspec status --change "<name>"`: proposal is next, and specs are not marked skipped unless intended.

5. **Generate the artifacts.** Invoke `/opsx:continue <name>` repeatedly until `openspec status --change "<name>" --json` reports `isComplete: true`. `draft.md` is the source of intent for every artifact. Migrate, never duplicate:
   - Why, What Changes, capabilities, impact → `proposal.md`
   - Decisions with alternatives, design-shaped content, and (b) earmarks → `design.md`
   - Task-shaped content and (c) earmarks → `tasks.md`
   - Behavior → spec deltas
   - Notes → wherever they are load-bearing; anything load-bearing nowhere is dropped deliberately and reported

   After each artifact, check that it honours the proposal, migrates the relevant draft content, restates no other artifact, and adds no scope. Correct drift before continuing; if the drift is a better direction, update every affected artifact together.

   **Spec deltas:** run the behavior-contract self-check from `openspec/guide/spec.md`, including its grep, over `openspec/changes/<name>/specs/`. Reword or justify every hit before moving on.

   **ADRs:** every decision in `design.md` that earns an ADR (`adr/README.md`) links a `proposed` ADR. Write any that are missing now.

6. **Delete `draft.md`.** Skim it one last time: every load-bearing piece must have a home, because it is the only copy. Supporting files stay only if an artifact references them.

7. **Validate.**

   ```bash
   openspec validate --strict "<name>"
   ```

   Must pass before review. Fix structurally and retry.

8. **Independent review.** Spawn a fresh agent (Agent tool) whose only instruction is to run `/opsxx:verify-proposal <name>` and return its report verbatim. The reviewer reads artifacts from disk and does not see this context.

9. **Act on the verdict.**
   - `approved` — continue.
   - `approved-with-notes` — continue; if the warnings are material, ask whether to remediate first.
   - `changes-requested` — remediate the CRITICAL findings in this context, re-validate, and review again with a new fresh agent. At most 3 rounds; then STOP with the remaining findings and ask how to proceed.

10. **Stop short of commit.**

**Output**

- Artifacts generated
- Open-question triage: answered / design / tasks / asked
- Draft content deliberately dropped, if any
- ADRs written or linked
- `openspec validate --strict` result
- Reviewer verdict and findings
- Suggested commit: `docs(openspec): finalize <name>`

**Guardrails**

- Do not delete `draft.md` before step 6; `/opsx:continue` needs it as the migration source.
- Do not widen scope beyond the draft and the triage answers.
- Do not commit or push.
