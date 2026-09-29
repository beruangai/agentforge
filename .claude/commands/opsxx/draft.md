---
name: 'OPSXX: Draft'
description: Stash a change idea as a draft on the draft schema for later finalization
argument-hint: '<name> <draft details>'
category: Workflow
tags: [workflow, artifacts, draft]
---

Stash a change you already have in mind but are not ready to finalize. A draft is a change on the project-local `draft` schema: `.openspec.yaml` carries `schema: draft`, and the only artifact is `draft.md` — a hybrid of proposal-, design-, and task-shaped content that preserves intent, context, and initial considerations until `/opsxx:finalize` migrates it.

Differs from `/opsx:new` (scaffolds a delivery change without authoring) and `/opsx:explore` (pull-based thinking). Draft is push-based: the user owns the intent.

Rationale and invariants: `openspec/guide/draft-finalize.md`.

**Input**: `<name> <draft details>` — a kebab-case name, then the change in enough detail to draft: motivation, what changes, decisions already made, affected surfaces, open questions.

**Steps**

1. **Parse input.** If `<name>` is missing, not kebab-case, or names an existing change, resolve with **AskUserQuestion** — never auto-rename or overwrite. If the details are thin (under ~50 words of substance), ask for what is missing before scaffolding. Do not invent scope.

2. **Scaffold on the draft schema.**

   ```bash
   openspec new change "<name>" --schema draft
   ```

   OpenSpec writes `schema: draft` and `skip_specs: true` to `.openspec.yaml` (the draft schema has no specs artifact), so the draft validates. Do not edit either field.

3. **Load authoring instructions.**

   ```bash
   openspec instructions draft --change "<name>" --json
   ```

   Honour the `instruction`, `template`, `context`, and every entry in `rules`.

4. **Author `draft.md`** from the input, following the template.
   - Ground Why in current state — cite the documents, ADRs, and sections the input names.
   - Record decisions already made with the alternatives weighed. A decision that earns an ADR is recorded now as a `proposed` ADR per `adr/README.md` and linked from Decisions.
   - List everything undecided under Open Questions, including anything you notice while drafting. These are carried forward, not answered.
   - Faithful, not elaborative: thin input makes a thin draft.

5. **Offer, do not require, a refinement pass.** Report the open questions surfaced and ask whether to resolve any now or save them for finalize. If the user engages, update `draft.md` in place; otherwise stop.

**Output**

- Change name and directory
- One-line summary of Why
- Proposed ADRs written, if any
- Open questions surfaced
- Next step: `/opsxx:finalize <name>` when ready

**Guardrails**

- Create only `draft.md`, plus any supporting files the input supplies (probes, notebooks). No `proposal.md`, `design.md`, `tasks.md`, or `specs/`.
- Do not change `schema` or `skip_specs` — that is finalize's job.
- Do not run `/opsxx:verify-proposal`; drafts are not verifiable.
- Do not commit or push.
