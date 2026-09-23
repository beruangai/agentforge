# Kernel settlement — spike findings

**Read against the real SDK on 2026-09-22.** `@anthropic-ai/claude-agent-sdk@0.3.278`, Bun 1.4.0, macOS, the operator's Claude Max subscription, model `claude-sonnet-5` unless a case names another. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §E.

Source: `spikes/kernel-settlement/`, four runnable spikes, now the e2e tests in `packages/agentforge/e2e/kernel-settlement/`. Every message of every run is kept as JSONL — then under `spikes/out/`, now under `dist/packages/agentforge/e2e/` — so each claim below is evidence rather than recollection. Total model spend: **$1.84**.

These are observations of one SDK version on one day. They are re-checked by those tests, not by being trusted.

---

## The carrier tool is real, and it is named `StructuredOutput`

The single most load-bearing fact, because three other answers rest on it.

With `outputFormat: { type: 'json_schema', schema }`, the final submission is an **ordinary tool call**:

```json
{ "type": "tool_use", "id": "toolu_01AUUk…", "name": "StructuredOutput",
  "input": { "fileCount": 3, "totalBytes": 60, "names": ["a.txt","b.txt","c.txt"] },
  "caller": { "type": "direct" } }
```

answered by `"Structured output provided successfully"`, and surfaced on the result message as `structured_output`.

- The **tool_use input is the real payload**, not a placeholder. (The SDK's own `resumeDropsTurn` documentation calls the carrier's data a placeholder; that describes the *persisted transcript entry*, where the payload lives in a separate `structured_output` attachment — not the live `tool_use` block.)
- `StructuredOutput` is listed in the `system/init` message's `tools` array on **every** run observed. **So the kernel can assert the carrier's existence at startup**, from `init.tools`, before any work — which is the mitigation §E asked for.

## Naming: the allowlist name and the emitted name differ

`allowedTools: ['Task']` admits subagents, but the emitted `tool_use` blocks are named **`Agent`**. A count keyed on `Task` sees zero subagent calls while three are running. Anything AgentForge matches, counts or denies by tool name must be established from observed traffic, never from the allowlist spelling.

Also observed: **`allowedTools` does not narrow what is advertised.** With `allowedTools: ['Bash','Task','Read','Glob']` the init message still advertised all 31 built-in tools. `allowedTools` is a permission allowlist, not a tool-exposure filter. `disallowedTools` *does* bind (see E4).

---

## E1 — A final submission survives dispatched work in the foreground

**Answer: yes, in every shape tried. The foreground rule buys nothing here.**

Three scenarios, each with a known-answer fixture (3 files of 10/20/30 bytes) so a wrong answer is distinguishable from a lost one:

| Scenario | Turns | Tool calls | `structured_output` | Correct |
|---|---|---|---|---|
| control, no dispatch | 3 | 2 | present, valid | yes |
| three foreground subagents (`Agent` ×3) | 6 | 7 | present, valid | yes |
| twelve sequential `Bash` calls in one turn | 15 | 13 | present, valid | yes |

Cost $0.52. Exactly one `StructuredOutput` call per run; exactly one result per run.

**What this does not prove.** It does not prove dispatched work is *safe* generally — only that foreground dispatch does not cost the submission. The risk §REQ206 recorded has moved to E2, not disappeared.

## E2 — Background work: the §REQ206 failure changed shape rather than going away

**Answer: a resumed turn no longer cancels its tool calls. It does something quieter and worse — it publishes a second, contradictory outcome.**

The agent backgrounds `sleep 25 && echo finished > background-done.txt`, then submits immediately.

### Closed input — the string-`prompt` form, `-p`, stdin closed

- **Exactly one result.** `structured_output` present and valid.
- **No hold-back worth the name**: submission at 5298 ms, result at 5428 ms — 130 ms.
- **The background task is killed.** Its notification reports `"status": "stopped"`, and the marker file was never written, at the result or 28 s later. This matches the SDK's documented closed-input exception: hold-back tasks are killed when the held result is released, regardless of `perTaskStopAffordance`, because with stdin closed a `stop_task` control could never be delivered.

### Streaming input — the async-iterable form, stdin open

The background task completes at 30 547 ms and its `task_notification` **starts a whole new turn, with a second `system/init`**. That turn submits `StructuredOutput` again and produces a **second `result` message**:

```
RESULT #1 @6964ms   num_turns=3  structured={"startedBackgroundWork": true,  "note": "Started a background command …"}
system/task_notification @30548ms
system/init                              ← a second init, mid-stream
RESULT #2 @32360ms  num_turns=2  structured={"startedBackgroundWork": false, "note": "The previously started … completed"}
```

Both results carry `subtype: success`, `is_error: false`. The first is **not** cancelled. But the second answers a question nobody asked, and a consumer that keeps the last result it sees silently ships it.

**Consequences for the kernel, both of which are cheap and neither of which is optional:**

1. **The kernel uses the closed-input form.** It is the only one observed to produce exactly one result.
2. **The kernel takes the first result and stops reading.** "Exactly one outcome is published" (`ARCHITECTURE.md` §7) must be enforced by the kernel, because the SDK does not guarantee it on an open-input session.

### Background disabled — `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`

A genuine kill switch rather than a policy: the `run_in_background` **parameter is removed from the Bash tool's schema**. The model's attempt to use it returned

```
<tool_use_error>InputValidationError: Bash failed due to the following issue:
An unexpected parameter `run_in_background` was provided</tool_use_error>
```

after which it ran the command in the foreground. One result, valid structured output.

**A negative result worth recording:** in this run the model then reported `startedBackgroundWork: true` in its structured output, which was false — it had run the command in the foreground. Schema-valid, semantically wrong. Nothing in the SDK catches that; see E3.

## E3 — In-turn `PreToolUse` rejection

**Answer: it adds three things native re-prompting cannot do, at a cost, and it has two sharp edges.**

Five scenarios over `StructuredOutput`, cost $0.48.

| Scenario | Carrier submissions | Hook calls | Outcome | Cost |
|---|---|---|---|---|
| rule in the schema (`pattern`), no hook | 2 | — | SDK re-prompted once, then correct | $0.134 |
| same rule, hook denial instead | 3 | 3 (2 denials) | corrected in-turn, then correct | $0.140 |
| cross-field rule the schema cannot express | 3 | 3 (3 denials) | **no output at all** — see below | $0.105 |
| hook repairs via `updatedInput` | 1 | 1 (1 repair) | repaired value delivered, no extra turn | $0.034 |
| matcher names a tool that does not exist | 1 | **0** | ran to completion, hook never fired | $0.034 |

**What a hook adds:**

- **It sees the whole submission**, so it can enforce cross-field and business rules draft-07 cannot express.
- **`updatedInput` repairs deterministically.** The hook rewrote `summary` and the *delivered* `structured_output` carried the rewritten value, with **no additional model turn** — $0.034 against $0.140 for the denial path, a 4× difference. For any rule that has a computable correct answer, repair beats re-prompting outright.
- **The denial reason reaches the model verbatim**, as an `is_error: true` tool_result on the carrier.

**What it costs:** for a rule the schema *can* express, the hook was strictly worse — more submissions, more money, same answer. **Rules that fit in the schema belong in the schema.**

### Edge 1 — the model resists a denial that contradicts the contract

The cross-field scenario denied with a rule deliberately absent from both the prompt and the schema ("report the total in whole kilobytes"). The model refused, three times, and said why:

> "That error message is asking me to convert an exact byte total into rounded kilobytes, which contradicts both the field's description ("the total size") and the task you gave me (exact byte sizes). It reads as an injecte[d instruction]"

This is correct behaviour by the model and a real constraint on the mechanism: **an in-turn denial only produces a correction when its reason is consistent with the declared contract.** The schema-consistent denial (E3 case 2) was obeyed in two rounds. A guardrail whose reason contradicts the schema will be argued with, not obeyed.

### Edge 2 — a denial loop ends in a silent empty success

After the third refusal the run terminated with:

```
subtype: "success",  is_error: false,  structured_output: null
```

**A successful-looking result with no output.** `ARCHITECTURE.md` §7 says the settled output is validated before anything else sees it; this is the case that makes that non-negotiable. The kernel must treat *result present, `structured_output` absent* as `OUTPUT_INVALID`, never as success — and must cap its own correction attempts, since the model gave up before the hook's cap was reached.

### Edge 3 — a wrong matcher fails silently

`matcher: 'StructuredOutputs'` (plural) fired **zero times** and the run completed normally. No warning, no error. Exactly the failure §E anticipated. Mitigated by asserting `init.tools` contains every tool name the kernel's matchers reference, at startup, before work — see the carrier section above.

## E4 — Does every option reach and bind the run?

**Answer: the options tried all bind. An option the SDK does not know is silently ignored — and two bind by throwing rather than by returning a result.**

Cost $0.43. Each case asserts an observable consequence, not that the argument was passed.

| Option | Binds | Evidence |
|---|---|---|
| `maxTurns: 2` | yes | **throws** `Reached maximum number of turns (2)` |
| `maxBudgetUsd: 0.02` | yes | **throws** `Reached maximum budget ($0.02)` |
| `model: 'claude-haiku-4-5-20251001'` | yes | `init.model` and `modelUsage` both report it |
| `disallowedTools: ['Bash']` | yes | zero `Bash` tool_use blocks emitted, despite `allowedTools: ['Bash']` |
| `cwd` | yes | read `marker.txt` from the sandbox, not the process cwd |
| `systemPrompt` | yes | answered `BANANA` to "what is 2 + 2?" |
| `settingSources: []` | yes | project `CLAUDE.md` not loaded — answered `NONE` |
| `settingSources: ['project']` | yes | same fixture, answered `PINEAPPLE` |
| `thisOptionDoesNotExist` | **no** | run completed normally; the key was **silently ignored** |

### The limits throw; they do not return a result

`maxTurns` and `maxBudgetUsd` raise out of the async iterator:

```
Error: Claude Code returned an error result: Reached maximum number of turns (2)
```

rather than yielding a result message with `subtype: 'error_max_turns'`. `SDKResultMessage` declares those subtypes, so a kernel reading only result messages would be correct by the type and wrong in practice: it would never map `TURN_BUDGET_EXHAUSTED` and would instead surface an unhandled throw as a generic `FAILED`.

**The kernel must catch around the iterator and classify the thrown error**, not only the result message. `TURN_BUDGET_EXHAUSTED` and a budget outcome are reachable only that way.

### §REQ201's failure mode is live

`thisOptionDoesNotExist: 'surely-this-throws'` produced a completely normal successful run. **The SDK does not reject unknown option keys.** `ARCHITECTURE.md` §3 promises "every option a procedure sets reaches the SDK, or the task is rejected" — nothing in the SDK provides that, so AgentForge must provide it itself: validate the resolved option object against the SDK's own `Options` type at the boundary and refuse an unknown key. This is precisely the predecessor harness's silently-dropped `maxTurns`, still available to be repeated.

---

## What the kernel must do, gathered

Every item below is forced by an observation above, not inferred.

1. **Use the closed-input (`prompt` string) form.** Open input can produce a second result (E2).
2. **Take the first result and stop reading.** One outcome is the kernel's guarantee, not the SDK's (E2).
3. **Catch around the iterator.** `maxTurns` and `maxBudgetUsd` bind by throwing (E4).
4. **Treat `subtype: success` with absent `structured_output` as `OUTPUT_INVALID`** (E3).
5. **Validate the resolved options against the SDK's `Options` type and refuse unknown keys** — the SDK ignores them (E4).
6. **Assert at startup that `init.tools` contains every tool name the kernel's hook matchers reference** — a wrong matcher is silent (E3).
7. **Put a rule in the schema when the schema can express it**; reserve hooks for what it cannot (E3).
8. **Prefer `updatedInput` repair over denial** where a correct value is computable: 4× cheaper and no extra turn (E3).
9. **Cap in-turn correction attempts in the kernel** — the model may stop trying before a hook's own cap is reached (E3).
10. **Keep a guardrail's denial reason consistent with the declared contract**, or the model will treat it as injection and refuse (E3).

## What remains open

- **Whether to set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the base image.** It is a hard, schema-level kill switch, and with closed input the tasks are killed at the result anyway — so the choice is between a task killed abruptly at the end and one that never starts. A procedure that genuinely wants background work has no way to opt in once the image sets it. Not settled here; see `DESIGN_OPTIONS.md` §E's remaining note.
- **Whether the second-result behaviour also occurs on a closed-input run whose background task finishes *before* the result.** Every closed-input run observed had the task still live at the result.
- **`maxTurns` interaction with a hook denial loop.** The denial scenarios ran under `maxTurns: 25` and stopped for other reasons.
