# Tasks

Group 1 records the requirements. Groups 2 and 3 are the package work and are independent of each other. Group 4 lands both on the examples and needs groups 2 and 3. Group 5 closes the records.

## 1. Requirements

- [x] 1.1 `docs/REQUIREMENTS.md` gains §REQ210 and §REQ211 in "Controlling the run", as the operator accepts them. Verify by reading them against the spec deltas:
  - **§REQ210:** a procedure composes its agent's context from reusable, typed pieces — static content from files its layers carry, dynamic content from its inputs — into one function it calls. A missing input is caught at compile time; a missing file fails the run before it starts.
  - **§REQ211:** what AgentForge derives from a task for a run is given to the procedure as one set of run options it composes, never applied unless the procedure does.

## 2. Run options from the task

- [x] 2.1 `TaskContext.agentOptions` replaces `filesystemPermissions` and `filesystemDirectories`. The registry middleware builds it: `additionalDirectories` from every mount and `allowedTools` from the merged baseline rules, or `{}` without mounts. The base-options scaffold's comment names it. Verified by `nx run @beruangai/agentforge:test`:
  - `agentOptions` with two mounts and with none;
  - the generator's snapshot.

## 3. Context composition

- [x] 3.1 In `server/harness/prompt.ts`: `ContextContent`, `ContextBlockFunction` and `composeContext`, exported from `/agent`. Verified by unit tests:
  - the content of sync and async parts comes back in order;
  - composites nest;
  - an empty composition returns nothing.

  The type tests, which `nx run @beruangai/agentforge:typecheck` checks, cover the intersected input, a no-input part adding nothing, and a missing variable (`@ts-expect-error`).
- [x] 3.2 A `ContextBlock` takes `filepath` as the alternative to `context`. It is reserved, never an attribute, and read against the run's `cwd` at render time, at the top of the prompt and in a command's context. `CommandBlock.context` takes `ContextContent`. Verified by unit tests:
  - a relative and an absolute file render exactly as the same block inline, at the top and in a command's context;
  - a content block in a command's context renders in place;
  - an unreadable file, both keys and neither key each fail the run before `query()`, naming the file.

## 4. Examples

- [x] 4.1 golden-kata:
  - its base layer gains `context.ts` with `kataContext`: the file contract as a file-backed `protocol` block from `$claude/fragments/kata-files.md`, moved out of `CLAUDE.md`, and the kata directory;
  - the writer and the grader keep their procedure instructions in their layers' `$claude/fragments/`, and each prompt is one composite of `kataContext` and its own dynamic function;
  - both procedures compose `context.agentOptions`.

  Verified by `nx run @beruangai/golden-kata:e2e`, and by `nx run @beruangai/golden-kata:e2e-agentcore` after its deploy.
- [ ] 4.2 smoke-coverage's procedures compose `context.agentOptions` in place of the two fields. Verified by `nx run @beruangai/smoke-coverage:e2e`, and by `nx run @beruangai/smoke-coverage:e2e-agentcore` after its deploy.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **The root README, "Implement it":** context functions, `composeContext`, file-backed blocks, `composeOptions(baseOptions(), context.agentOptions, …)`, and where static instructions live, with the ordering for caching;
  - **ARCHITECTURE §3:** `context.agentOptions` in the filesystems paragraph and the task context;
  - **ARCHITECTURE §6:** context functions and file-backed blocks in the prompt;
  - **ADR 0015, mutated in place:** the handler receives `context.agentOptions`;
  - **GLOSSARY:** context function, agent options, and the task context entry.
