---
name: 'OPSXX: Batch Verify Proposals'
description: Per-change verification (optional) plus cross-change cohesion review over a set of finalized changes
argument-hint: '[--skip-per-proposal] [name1 name2 ...]'
category: Workflow
tags: [workflow, verify, review, batch]
---

Run `/opsxx:verify-proposal` over a set of finalized changes, then review them together for cohesion no single review can see. Standalone, it audits a batch before archive. Inside `/opsxx:batch-finalize` it runs with `--skip-per-proposal`, since each finalize already verified its own change.

**Input**: `[--skip-per-proposal] [name1 name2 ...]`. Without names, the target set is every change not on `schema: draft`, confirmed with **AskUserQuestion** before starting.

**Steps**

1. **Resolve the target set.** A named change on `schema: draft` stops the run; drafts are not verifiable. An empty set stops with "No finalized changes to verify." For a single change without `--skip-per-proposal`, suggest `/opsxx:verify-proposal <name>` instead.

2. **Per-change verification** (skipped with `--skip-per-proposal`). Spawn one fresh agent per change in a single message, each running `/opsxx:verify-proposal <name>` and returning its report verbatim. CRITICAL findings do not block step 3; both go to the user together.

3. **Cross-change cohesion review.** Rebuild the baseline as in `/opsxx:verify-proposal` step 4 for the union of surfaces the batch touches, plus in-flight changes outside the batch that reference it or that it references. Re-read every artifact from disk. Tag each finding `[internal]` (within the batch) or `[grounded]` (against the baseline):
   - **Shared surfaces** — changes touching the same capability, document, file, or ADR are compatible and land in a feasible order.
   - **Cross-references** — every named change exists and defines what is claimed.
   - **Terminology and shapes** — the same thing is named and shaped the same across the batch and matches `docs/GLOSSARY.md`; no decision is argued differently in two changes.
   - **Dependency ordering** — stated explicitly, and feasible.
   - **Collective rule drift** — changes that each pass alone but introduce different flavours of one pattern.
   - **Aggregate scope** — the batch together stays within what its drafts committed to.
   - **Baseline consistency** — every change computes its deltas against the same assumed landing state. Divergent assumptions are CRITICAL.
   - **ADRs** — no number collisions, and no two changes proposing conflicting ADRs.

4. **No remediation.** This command reviews only. Report each CRITICAL finding with the change to fix; when called from `/opsxx:batch-finalize`, return the findings to the caller.

5. **Report.**

   ```
   ## Batch Verify Proposals Report

   ### Target set
   - [changes]
   - Mode: per-change + cohesion | cohesion only

   ### Per-change verdicts
   [omitted with --skip-per-proposal]

   ### Cohesion grounding baseline
   - Documents and ADRs read: [list]
   - Source files confirmed: [N]
   - In-flight changes outside the batch: [list or none]

   ### Cohesion findings
   [by severity, tagged, with changes affected, location, and fix]

   ### Overall verdict
   - `all-approved` — every change approved (or skipped) and cohesion clean
   - `approved-with-notes` — no CRITICAL anywhere
   - `changes-requested` — CRITICAL in any per-change review or in cohesion
   ```

**Guardrails**

- Review only — do not modify artifacts. Do not commit or push.
- Cohesion runs after per-change verification, never inside a per-change reviewer.
- With `--skip-per-proposal`, still read every artifact from disk.
