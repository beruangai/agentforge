# Tasks

Group 1 records the requirement. Group 2 is the package work, and group 3 runs it against a real model. Group 4 lands it on `smoke-coverage` and needs group 2. Group 5 closes the docs.

## 1. Records

- [x] 1.1 `docs/REQUIREMENTS.md` gains §REQ404 in "Identity and state". Verify by reading it against the spec delta. It says that an agent may keep Claude Code's auto memory — the `MEMORY.md` index and its files, never `CLAUDE.md` — in a directory a run declares, so a later task recalls it; that it is optional; and that a run declaring none keeps none.

## 2. The kernel

- [x] 2.1 `server/harness/system-prompt.ts`: `SystemPromptFragment`, the `SYSTEM_PROMPT_FRAGMENTS` registry holding the auto-memory fragment (the spike's text, as a template over the directory), and `composeSystemPrompt(spec)` per the design's table, the preset refused when a fragment applies. Verified by unit tests covering:
  - each `systemPrompt` form with the fragment applying;
  - no fragment applying, where the prompt passes through untouched;
  - the preset refused, naming it and the fragment.
- [x] 2.2 `AgentRunSpec.memoryDirectory` in the kernel. Verified by kernel unit tests against the scripted `query()`:
  - with a directory, the call's `settings` carry `autoMemoryEnabled: true` and `autoMemoryDirectory`, merged with the procedure's own, and its `systemPrompt` ends with the memory fragment;
  - without one, `env` carries `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and the system prompt is the procedure's own;
  - the logged `agentforge.prompt` and the record's hash are of the composed system prompt;
  - each refusal in the design's error table fails `EXECUTION_ERROR` before `query()` is called.

## 3. Against a real model

- [x] 3.1 `integ/model/auto-memory/auto-memory.test.ts` through `runAgent`, in a sandbox, every run fenced (`blockReadsOutsideWorkingDirectories`) with the memory directory outside its working directories. Verified by `nx run @beruangai/agentforge:integ --configuration=model -- integ/model/auto-memory`:
  - a run with a memory directory and `Read`, `Write` and `Edit`, told a fact to remember, leaves a topic file and a `MEMORY.md` line in the directory;
  - a second run with the same directory and no tools answers with the fact;
  - a run with no memory directory reports no `memory_paths.auto` in its `init`.

  The research note gains the variable that disables auto memory, dated.

## 4. Examples

- [x] 4.1 `smoke-coverage-infra` declares a `Memories` bucket beside `Notebook`. It is passed to `hello-agent` as `filesystems: { memories }`, with its name a stack output and among the buckets `empty-buckets.ts` empties before destroy. Verified by `nx run @beruangai/smoke-coverage-infra:synth`.
- [x] 4.2 `hello-agent` gains `Remember` (a space and a fact in; it saves the fact to memory, with `Read`, `Write` and `Edit`) and `Recall` (a space and a question in; no tools; it answers from memory). Both mount the space from shared `MEMORIES` options (`bucket: 'memories'`, `localRoot: '/workspace/memories'`) with `subpath: spaces/<space>`, declare its `localPath` as `memoryDirectory`, and pass `context.filesystemDirectories` and `context.filesystemPermissions` as the other procedures do; `Remember` pushes on `TASK_STATE_COMPLETED`. They run fenced, from the base options. The AgentCore suite saves a fact, stops the container, then recalls it in a new runtime session. Verified by `nx run @beruangai/smoke-coverage:e2e-agentcore` after its deploy. The README's procedure table lists both.

## 5. Docs

- [x] 5.1 Verify each doc by reading it against design.md:
  - **ARCHITECTURE §6:** the kernel composes the system prompt from the procedure's and the fragments a run calls for, never the preset, under [ADR 0017](../../../adr/0017-agentforge-adds-system-prompt-fragments-never-the-preset.md); `memoryDirectory`, the settings the kernel owns, and auto memory off without it;
  - **ARCHITECTURE §3, the filesystems paragraph:** memory as a filesystem, one memories bucket, a space as a subpath under the shared options' roots, one live task per space in a container, concurrency across containers and deletes the consumer's;
  - **GLOSSARY:** auto memory, memory space, system-prompt fragment.
