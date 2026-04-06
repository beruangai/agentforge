---
name: "DEV: Reflect"
description: "Capture session learnings into persistent memories and align all knowledge stores"
category: Development
tags: [development, memory, learning, reflection]
---

# Session Reflection

Reflect on this session and capture learnings into the right persistent stores. This is a thinking-then-acting workflow — internalize first, then write.

**Input**: `$ARGUMENTS` (optional — focus area or specific learnings to capture)

---

## Phase 1: Internalize

Review the full conversation history for this session. Identify:

1. **Pain points** — Where did you struggle, produce wrong output, or need multiple attempts?
2. **Human interventions** — What did the user correct, redirect, or clarify? These are the highest-signal learnings.
3. **Ambiguity** — Where was guidance missing or unclear, causing you to guess wrong?
4. **Misalignment** — Where did your behavior diverge from what the user expected?
5. **Validated approaches** — What worked well that wasn't obvious? (Don't only learn from failures.)
6. **Decisions made** — Any architectural, design, or process decisions that define how this project works.

Summarize your findings concisely before proceeding. Ask the user if your read is accurate and if there's anything you missed.

---

## Phase 2: Read Current State

Read all existing knowledge stores to understand what's already captured:

**Git-committable (project knowledge):**
- `CLAUDE.md` — project development guide
- `.claude/rules/*.md` — all rule files
- Any project docs relevant to findings (openspec specs, READMEs, TECH_SCOPING.md, etc.)

**Claude Memories (AI optimization):**
- Read `MEMORY.md` index
- Read each referenced memory file

Don't read everything blindly — read what's relevant to the learnings you identified in Phase 1.

---

## Phase 3: Classify & Route

Each learning goes to exactly ONE destination. Use this decision tree:

### 1. `.claude/rules/{category}.md` — Behavioral rules for Claude in this project
**Use when:** The learning is a repeatable instruction that should govern Claude's behavior in specific file contexts or workflows. Rules are scoped and triggered by path globs.

Examples:
- "When editing test files, always use vitest patterns not jest"
- "When working in temporal-workflow package, mock sandbox at boundary"
- "When generating TypeScript, use Bun-compatible imports"

**Format:** Follow existing rule file conventions with `paths:` frontmatter for scoping.

### 2. `CLAUDE.md` — Project development guide
**Use when:** The learning is a project-wide guideline, requirement, convention, or workflow that any AI assistant (or human) needs to know. This is the canonical "how we work" document.

Examples:
- New build/test commands
- API patterns or conventions
- "What not to do" additions
- Development workflow changes

**Keep it:** Concise, scannable, actionable. CLAUDE.md is already loaded into every conversation — bloat costs tokens.

### 3. Claude Memories (`/memories`) — AI-specific optimization
**Use when:** The learning optimizes how Claude works with this specific user/project but doesn't belong in source control. User preferences, working style, context that helps Claude but isn't a project rule.

Examples:
- User's communication preferences already captured
- Working patterns ("user prefers X approach for Y situations")
- Project context not derivable from code (stakeholder context, timelines)
- References to external systems

**Do NOT duplicate** what's in CLAUDE.md or rules. Memories supplement, not mirror.

### 4. Project docs (openspec specs, README, TECH_SCOPING.md, etc.)
**Use when:** The learning reveals that existing project documentation is wrong, incomplete, or missing a critical decision. The docs define the project itself — they're for humans and AI alike.

Examples:
- Architecture decision that contradicts or isn't captured in TECH_SCOPING.md
- Spec that doesn't match what was actually built
- README that's out of date with current setup

---

## Phase 4: Apply

Make all updates. For each change:
- **Edit existing content** rather than appending new sections where possible
- **Remove outdated content** that contradicts new learnings
- **Keep everything concise** — every token in CLAUDE.md and rules costs context in every future conversation
- **Resolve conflicts** — if two sources say different things, fix both to agree

### Ordering
1. Project docs first (if any need fixing) — these are source of truth
2. CLAUDE.md updates — align with project docs
3. Rules — add/update behavioral rules
4. Memories — capture AI-optimization context last

### For each destination, before writing:
- Re-read the target file
- Identify exactly where the new content fits (or what it replaces)
- Make surgical edits, not wholesale rewrites

---

## Phase 5: Verify Alignment

After all writes, do a quick consistency check:
- Do CLAUDE.md and rules agree with each other?
- Do memories reference things that still exist in the project?
- Are there any contradictions between what you just wrote and existing content?

Report what you changed and why, grouped by destination. Keep the summary tight.

---

## Guardrails

- **Ask before writing** if you're unsure about classification. Show the user your plan.
- **Don't capture ephemeral things** — debugging steps, one-off fixes, conversation-specific context.
- **Don't duplicate across stores** — one source of truth per fact.
- **Don't bloat CLAUDE.md** — it's loaded every conversation. Every line must earn its place.
- **Don't capture code patterns derivable from reading the code** — that's what the code is for.
- **Prefer updating over appending** — align existing content rather than adding parallel sections.
- **No self-congratulatory summaries** — state what changed and move on.
