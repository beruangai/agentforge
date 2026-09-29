---
name: 'OPSXX: Batch Finalize'
description: Finalize several drafts in parallel, then review them together for cross-change cohesion
argument-hint: '[name1 name2 ...]'
category: Workflow
tags: [workflow, artifacts, finalize, batch]
---

Finalize a set of drafts that share surfaces — capabilities, documents, terminology — and must agree once finalized. A thin coordinator: `/opsxx:finalize` per draft, then one cohesion review.

**Input**: `[name1 name2 ...]`. Without names, the target set is every change on `schema: draft`:

```bash
grep -l '^schema: draft$' openspec/changes/*/.openspec.yaml
```

**Steps**

1. **Resolve the target set.**
   - Names given: each must exist on `schema: draft`. For any that does not, ask with **AskUserQuestion** whether to skip it or abort.
   - No names: present the discovered drafts with **AskUserQuestion** and start only on confirmation.
   - An empty set stops with "No drafts to finalize." For a single change, suggest `/opsxx:finalize <name>`.

2. **Finalize in parallel.** Spawn one fresh agent per draft in a single message, each running `/opsxx:finalize <name>` and returning its Output block verbatim with any warnings. Workers share no state. Where finalize would ask the user, the worker returns the question instead of guessing; ask the collected questions together, then resume the affected workers with the answers.

3. **Gather results** — artifacts, triage, validation, and per-change verdict. A change still `changes-requested` after its remediation rounds is flagged but does not block step 4.

4. **Cohesion review.** Spawn a fresh agent running `/opsxx:batch-verify-proposals --skip-per-proposal <names>` over every change that completed finalize, returning its report verbatim.

5. **Remediate cohesion CRITICALs.** For each, spawn a remediation agent per affected change with the report, then repeat step 4. At most 2 cohesion rounds; then STOP and escalate the remaining findings.

6. **Report.**

   ```
   ## Batch Finalize Report

   ### Finalized
   | Change | Validation | Verdict | Notes |
   |--------|------------|---------|-------|

   ### Cross-change cohesion
   [final report from /opsxx:batch-verify-proposals]

   ### Overall
   all-approved | approved-with-notes | changes-requested

   ### Next step
   Review the diff and commit — one commit per change, or one if the batch is tightly coupled.
   ```

**Guardrails**

- Do not start on auto-discovered drafts without confirmation.
- Cohesion review is delegated, never inlined here or inside a finalize worker.
- A worker that fails for infrastructure reasons is retried once in a fresh agent, then reported as failed.
- At most 3 remediation rounds per change (inside finalize) and 2 cohesion rounds.
- Do not commit or push.
