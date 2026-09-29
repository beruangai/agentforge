# Draft → Finalize → Verify

A project extension to the OpenSpec workflow for changes not yet ready to finalize. Per-step mechanics live in `.claude/commands/opsxx/`; this guide holds the rationale and invariants.

## Why drafts exist

`/opsx:propose` and `/opsx:ff` author every artifact at once. That fits a change whose shape is known. It does not fit:

- an idea worth stashing now and finalizing later
- a change with open questions or unsettled scope, where downstream artifacts would be rewritten on every iteration

A draft stores intent, context, and initial considerations in one file so none of it is lost before the change is ready.

## The draft schema

A draft is a change on the project-local schema `openspec/schemas/draft/`: `.openspec.yaml` carries `schema: draft`, and the only artifact is `draft.md`.

- The schema is the draft marker. `openspec status` shows it; no bespoke field is needed.
- The draft schema has no specs artifact, so `openspec new change --schema draft` sets `skip_specs: true` and the draft passes `openspec validate`.
- `rules.draft` in `openspec/config.yaml` carries the project's drafting rules.
- A draft is neither implementable nor archivable. OpenSpec blocks neither mechanically; the draft state is stated, and the archive guidance says so. Harden only if that proves insufficient.

## Drafting discipline

- A draft MAY mix proposal-, design-, and task-shaped content. That is expected, not a defect.
- Faithful to the input, not elaborative. Thin input makes a thin draft.
- Everything undecided goes under Open Questions — never an invented answer, never silently dropped.
- A decision that earns an ADR is recorded when it is made; in a draft, as a `proposed` ADR (`adr/README.md`).

## Finalize

`/opsxx:finalize` converts a draft to `spec-driven`:

1. **Triage open questions.** Each is answered now, earmarked for `design.md`, earmarked as a task, or asked. A question that would resolve an open design option (§ODO###) is always asked.
2. **Switch the schema.** `schema: spec-driven`, and `skip_specs` removed unless the change genuinely makes no spec-level behavior change. Left in place, `skip_specs` marks specs skipped and conflicts with validation once spec files exist.
3. **Author the artifacts from the draft.** Migration, never duplication:

   | Draft content | Home |
   |---|---|
   | Why, What Changes, capabilities, impact | `proposal.md` |
   | Decisions with alternatives, design-shaped detail | `design.md` |
   | Task-shaped detail | `tasks.md` |
   | Behavior | spec deltas |
   | Notes | wherever load-bearing; the rest dropped deliberately and reported |

4. **Delete `draft.md`** once every load-bearing piece has a home. OpenSpec ignores extra files, so a leftover `draft.md` would go unnoticed; verification refuses a change that still carries one.
5. **Validate, then verify independently.**

## Verification is independent and grounded

`/opsxx:verify-proposal` runs in a fresh context and re-reads every artifact from disk; the generator's summary is not evidence. It reviews the change against the state it will land into — project documents, in-force ADRs, open design sections, current source, the spec baseline, and in-flight changes — across correctness, completeness, cohesion, and simplification, each on an internal and a grounded axis. It is the rule that no output is self-certified, applied to change artifacts.

## Batch variants

- `/opsxx:batch-finalize` finalizes several drafts in parallel, then delegates cross-change cohesion to `/opsxx:batch-verify-proposals --skip-per-proposal`.
- `/opsxx:batch-verify-proposals` also runs standalone to audit finalized changes before archive.

## Invariants

- A draft is `schema: draft` with one `draft.md`; finalize is the only path to a delivery schema.
- Finalize migrates; nothing is dropped silently.
- Verification refuses drafts and changes still carrying `draft.md`.
- A decision that earns an ADR is recorded when it is made, in any phase.
