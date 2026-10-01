# Design

Guidance, not prescription: adapt to actual constraints. The platform facts are in [`research/claude-agent-sdk.md`](../../../docs/research/claude-agent-sdk.md), spiked 2026-10-01 against SDK `0.3.280` (CLI 2.1.284).

## Context

- **Several runs already work.** `context.runAgent` calls the kernel once per call. Each call emits its own record over IPC, the executor appends it to the task's `runs`, and `GetTask` returns `runs` to the client. Nothing tests more than one, and ARCHITECTURE and §REQ206 read as one run per task.
- **The kernel refuses a run once the task's signal has aborted.** Its first line throws `TaskCanceled`, so a run started after a cancel never reaches the SDK.
- **Every run has an `outputFormat`,** so an agent can only finish by submitting through the `StructuredOutput` tool, which is in `init.tools`.
  - A `Stop` hook fires after that submission, and its block is ignored.
  - A `PreToolUse` hook on `StructuredOutput` that denies makes the agent resubmit in-turn, and the result carries the accepted resubmission.
  - A permanent denial ends `error_max_structured_output_retries` after the CLI's `MAX_STRUCTURED_OUTPUT_RETRIES` (5) attempts, and `result.errors` carries the last reason.
  - `settle` maps that subtype to `OUTPUT_INVALID` with a fixed message, so the reason is dropped today.
  - **The CLI checks a submission only against the JSON Schema the agent sees.** `format` and Zod refinements are not enforced, so today they surface only in `settle`'s parse after the run, as `OUTPUT_INVALID` with no retry. No `PreToolUse` hook exists in the package, although TrendBot's harness had one that re-parsed the submission with Zod.
- **A mount** reaches the handler as `MountedFilesystem { localPath, permissions }`, built by `MountLifecycle`. The push sends only the write globs (ADR 0015).
- `ContextBlock` renders as a tagged text block. A context block's own attributes, such as `source`, render as tag attributes.
- **`persistSession: false` conflicts with a session store.** It throws at startup when combined with one, and the deployment declares a store on AgentCore. A utility run therefore keeps the default and its transcript is mirrored like any other.

## Goals / Non-Goals

**Goals:** the behaviour in the three spec deltas, verified in unit tests, one model `integ` slice, and both examples' e2e, locally and on AgentCore.

**Non-goals:** see the proposal. Also: no change to the CLI's retry limit by AgentForge. No new task protocol message: a guard's denials go to the container log, not to the record.

## Public API

```ts
// @beruangai/agentforge/agent

/** A check that must pass before the agent's answer is accepted; the agent contract is always checked beside it. */
export type StopGuard = () => Promise<StopGuardDenial | undefined>;
export interface StopGuardDenial {
  /** Told to the agent, in its turn: what is wrong and what to do. */
  readonly reason: string;
}

export interface AgentRunSpec<Output> {
  // …existing fields
  readonly guardrails?: {
    /** All run on each answer the agent submits; any denial refuses it. */
    readonly stop?: readonly StopGuard[];
  };
}

export interface MountedFilesystem {
  readonly localPath: string;
  readonly permissions: { readonly allow: readonly string[] };
  /** The local path of `relativePath` in the mount; throws if it is absolute or climbs out. */
  path(relativePath: string): string;
  /** As `path`, and throws unless a write glob of the scope matches it. */
  writablePath(relativePath: string): string;
}

export interface DistillDocument {
  /** Names the document in citations: a file path, a URL, an id. */
  readonly source: string;
  readonly content: string;
}
export interface DistillSpec {
  readonly documents: readonly DistillDocument[];
  /** What the next run needs from them; the distillation keeps that. */
  readonly instruction: string;
  /** Estimated tokens; 12 000 by default. A distillation may run to 1.5×. */
  readonly capTokens?: number;
  /** `haiku` by default. */
  readonly model?: string;
}
/** The documents as context blocks: unchanged within the cap, otherwise one distillation. */
export function distill(
  context: Pick<TaskContext, 'runAgent'>,
  spec: DistillSpec,
): Promise<readonly ContextBlock[]>;
```

Usage, as the skill will show it:

```ts
const kata = context.filesystems.kata;
const grounding = await distill(context, { documents, instruction: 'What the writer needs about prior katas' });
const run = await context.runAgent({
  prompt: ['Write the kata…', ...grounding],
  output: KataSchema,
  guardrails: {
    stop: [
      async () => existsSync(kata.path(SOLUTION_FILE)) ? undefined : { reason: `Write ${SOLUTION_FILE} before answering.` },
    ],
  },
  options: …,
});
```

## Decisions

### Several runs: stated and tested, not built
No kernel change. ARCHITECTURE §6 states that a procedure is one process, and that its runs, in sequence or concurrently, are its own to coordinate. Each run settles and is recorded on its own, and the task's outcome is the handler's return. §REQ206 is amended and §REQ207 added. A task-process unit test covers two runs, none, and one after a cancel; `smoke-coverage`'s e2e asserts two records on one task.

### One answer check on the submission: the contract and the guards
Every run gets one `PreToolUse` entry of the kernel's own, with matcher `StructuredOutput`, appended after the procedure's hooks (§REQ204: additive; a procedure's own `PreToolUse` hooks are untouched). Consumers never add the contract check: AgentForge applies it to every run.

**On each submission, the hook collects every failure before it answers:**
- **The contract.** `spec.output.safeParseAsync(unwrapStructuredOutput(tool_input, wrapped))`, the same parse `settle` makes. Asynchronous, so an async refinement works. A failure contributes `z.prettifyError`, under a line saying the contract is stricter than the JSON Schema the agent was shown.
- **Every stop guard,** run concurrently (`Promise.allSettled`). A denial contributes its reason.
- **A guard that rejects** is a defect, not something to tell the agent. The hook records the error and denies, the kernel aborts the run, and the run fails `EXECUTION_ERROR` naming it.

**Then it answers:**
- If anything failed, it returns `permissionDecision: 'deny'` with one reason holding every failure, the contract's first. It logs `{ event: 'agentforge.answer.refused', failures }` to the container log (§REQ601).
- Otherwise it returns `{}`.

`settle` keeps its parse after the run as the last word. The hook makes it unreachable in practice, but the answer that is returned is still parsed by the schema that types it.

*Alternatives:*
- **The SDK's `Stop` event, which the operator first chose.** Spiked: its block after a submission is ignored, so it cannot hold an answer back.
- **A separate hook for the contract, as TrendBot had.** Two `PreToolUse` hooks on one submission each answer on their own, so the agent learns the failures one denial at a time and spends an attempt on each. The operator chose one hook so that every failure comes in one denial.
- **A kernel counter defaulting to 3.** The CLI already bounds attempts at 5 and ends the run with a typed subtype. A second counter would have to let an unmet answer through and fail after the run; it duplicates the bound for nothing. A procedure wanting fewer attempts sets `MAX_STRUCTURED_OUTPUT_RETRIES` in its `env`. The limit is shared with the CLI's own schema refusals, which is right: all are "this answer is not acceptable".

`settle` now carries `result.errors` into the `OUTPUT_INVALID` cause for `error_max_structured_output_retries`. That cause therefore names the last failures. An agent may instead give up after a refusal and end its turn without answering (seen on Haiku after two refusals): the kernel keeps the last refusal and the `OUTPUT_INVALID` cause for a run without an answer names it too.

### Paths resolve inside a mount, and writes inside the write scope
`MountLifecycle` builds `path` and `writablePath` onto the `MountedFilesystem` it hands the handler.
- `path` refuses an absolute path, and any path whose normalised form starts with `..`.
- `writablePath` also requires `path.matchesGlob` (Node built-in) to match one of the mount's write globs.

Both throw a plain `Error`, which fails the task `EXECUTION_ERROR` unless the handler catches it. The filesystem specification already names the push's globs as the scope. One dialect question remains, whether Node's matcher and the S3 kind's include patterns agree on `**`, and the tests pin the shapes used (`**`, `dir/**`, a file).

*Alternative:* file operations on the mount (`fileExists`, `readFile`, `writeFile`…). Declined with the operator: `node:fs` does them, and only resolution and the write scope are the mount's to know.

### `distill` is a helper over `context.runAgent`
`server/harness/distill.ts`, exported from `/agent`.
- **Estimate.** `Math.ceil(totalCharacters / 4)` over every document's content; the estimate is stated in the API, not hidden.
- **Within the cap:** one `{ tag: 'document', source, context: content }` block per document, and no run.
- **Over the cap:** one `context.runAgent` call with:
  - a utility preset: `model`; `tools: []`; `settingSources: []`, so no `.claude/` layer, hooks or skills; `permissionMode: 'dontAsk'`; `maxTurns: 3`;
  - a fixed system prompt: compact for the instruction, keep only what is supported, cite every kept fact as `source#Lnn`, never infer;
  - the documents as line-numbered context blocks;
  - the instruction last, so a command could still lead;
  - output `z.strictObject({ distillation: z.string() })`.
- **Result.** A distillation whose estimate exceeds `1.5 × capTokens` throws `TaskFailure(OUTPUT_INVALID, …, { payload: distillation })`. Otherwise it returns `[{ tag: 'distillation', description: instruction, sources: <count>, context: distillation }]`.
- **Edge cases.** No documents returns `[]`. A `capTokens` that is not a positive integer throws before anything runs.

*Alternative:* a separate "pure" kernel path with no task context. Declined: it would duplicate settlement, and lose cancellation and the run's record (cost).

## Error handling

| Failure | Outcome |
|---|---|
| The contract refuses a submission, or a guard denies, and the agent fixes it within the CLI's attempts | The run returns the accepted answer |
| A check still fails when the attempts are exhausted | `OUTPUT_INVALID`, carrying the CLI's message with the last failures |
| A guard throws | `EXECUTION_ERROR`, naming the guard's error; the run is aborted |
| `path` or `writablePath` refuses a path | `Error` naming the path and the mount or the scope; `EXECUTION_ERROR` unless caught |
| A distillation beyond 1.5× its cap | `OUTPUT_INVALID`, carrying the distillation |
| The utility run fails or is cancelled | As any run: its cause, or `TASK_STATE_CANCELED` |
| A run started after a cancel | `TaskCanceled` before the SDK is reached; `TASK_STATE_CANCELED` |

## What earns which test

- **Model `integ`, because it can drift:** `integ/model/answer-check/`. The answer check against a real model:
  - a contract with a `format: uri` field the agent first fills with a non-URL: the agent is denied and the run returns a URL;
  - a guard requiring a file the agent writes in response, after which the accepted answer is returned;
  - a guard never satisfied, which ends `OUTPUT_INVALID` carrying its reason.

  It asserts only what holds whichever way the model words its answer.
- **Settled once, a research note:** a `Stop` block after a submission is ignored (`research/claude-agent-sdk.md`, 2026-10-01).
- **Unit:**
  - the answer hook: the contract parsed from the unwrapped submission; all guards run though one denies; the contract's failure and every denial in one reason; a passing submission returns `{}`; a rejection recorded; installed on every run and after the procedure's hooks;
  - `settle`'s carried message;
  - `path` and `writablePath`;
  - `distill` against a stub `runAgent`: pass-through, the preset and prompt, the allowance edges, no documents;
  - task-process tests for two runs, none, and a run after a cancel.
- **e2e:**
  - `golden-kata`'s writer guards its kata files; its existing local and AgentCore e2e run through the guard.
  - `smoke-coverage` gains `DistillThenAnswer`, local and AgentCore. Large documents and a small cap force a distillation, and the task records two runs; documents within the cap record one.

## Risks / Trade-offs

- **The CLI's retry limit is shared with schema refusals.** An agent that misses the schema twice has three tries left for the guards. → Acceptable, since both refuse an answer. A procedure can raise the limit through `env`.
- **The CLI's tool-input validation runs before the hook,** as for any tool (the operator, 2026-10-01). A submission the JSON Schema already refuses is answered by the CLI alone, without the guards' reasons. → Only for what the agent's own schema states; everything beyond it is batched.
- **The answer hook depends on `StructuredOutput` keeping its name.** → The kernel's dead-matcher check already fails a run whose matcher names no tool in `init.tools`, so a rename fails loudly. The model `integ` slice catches a behaviour change.
- **The chars/4 estimate** is crude for code and non-Latin text. → The allowance absorbs it. `capTokens` is an estimate by contract, not a billing figure.
- **Node's glob dialect versus the push's.** → Pinned by tests for the shapes used.
- **Concurrent runs in one procedure share a working directory** and anything the procedure mounts. → The consumer's, stated in ARCHITECTURE.
