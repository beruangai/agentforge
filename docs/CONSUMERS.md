# Consumers

AgentForge exists for StrategyFoundry and TrendBot. They say what they need; AgentForge decides everything about meeting it.

| Consumer | Contract | Ids | Status |
|---|---|---|---|
| StrategyFoundry | `~/workspace/beruangai/StrategyFoundry/docs/AGENTFORGE_CONTRACT.md` | H1… | Drafting; adopts AgentForge from day one. Its **M0** is its own lowest bar, and no milestone here aims at it |
| TrendBot | `~/workspace/PlayTek/trendbot-monorepo/docs/AGENTFORGE_CONTRACT.md` | T1… | Draft, seeded from its specs. Runs today on its own [predecessor harness](lineage/predecessor-harness.md) — same name, not this — and refactors onto AgentForge when it adopts |

**Both contracts are unvetted drafts, written before this design existed.** Neither consumer has built against AgentForge, so a requirement often describes the mechanism its author had in mind rather than the behavior it protects. The distilled set below is what AgentForge answers to; the contracts are its sources.

## Rules

- **Distil, never transcribe.** Take what a requirement protects. Where it names a mechanism, meet the behavior and raise the wording.
- **AgentForge never edits a consumer's contract.** Anything unclear, infeasible, or in conflict with the other consumer is raised with the operator, in that consumer's repository.
- **This set becomes the contract.** The H and T documents are pre-adoption drafts, and they drift the moment a consumer builds against AgentForge. As each adopts, its contract is retired into this set, which hardens into the versioned contract both follow — so a breaking change here is reviewed with the operator against both consumers rather than negotiated twice.
- **Push back.** A requirement that costs more than it buys, encodes a workaround, or asks for something AgentForge cannot guarantee is renegotiated, not built.
- **Every proposal traces to distilled ids (D#) and through them to sources.** A capability no consumer needs is not built.
- **One consumer's need is met by configuration or a helper it calls** — never by a branch in the harness or the runtime.
- **The consumer owns its isolation strategy and its side effects**, including recovery when one may have partly happened.
- **No consumer vocabulary enters AgentForge.**
- **Re-distil when a contract changes.** Check each contract's git history since the last review; anything new enters this set or `DESIGN_OPTIONS.md`.

---

## What AgentForge answers to

### Declaring and typing

| | Requirement | Sources |
|---|---|---|
| **D1** | A caller invokes a procedure by name with typed input and receives a typed outcome. A wrong name or shape fails at compile time; there is no per-procedure wiring | H1, H2, T1 |
| **D2** | A procedure declares an outer contract and, separately, what the agent itself fills in. Computed fields and identifiers are added between them, never asked of the model | T18, both declarations |
| **D3** | Input and output are structured throughout, and parsing is strict in both directions and at every boundary. A non-conforming output fails loudly with its payload preserved — no coercion, no partial delivery, no silent drop — and field descriptions reach the agent with its schema | H7, H8, T15, T16, T17 |
| **D4** | A container that cannot serve the contract a caller compiled against refuses the task before any work, naming what it could not resolve | H3, T3 |

### Controlling the run

| | Requirement | Sources |
|---|---|---|
| **D5** | Every option a procedure sets reaches the SDK, or the task is rejected. Nothing accepted is silently dropped | H4, T7 |
| **D6** | A consumer controls a run's time budget and it is enforced. *Where* it is declared is AgentForge's: one budget per task, declared with the procedure and overridable per invocation, so a caller that sizes budgets per call is served without a second authority over when a run ends | H4, T2 |
| **D7** | A session starts from exactly what the procedure composed. Nothing is discovered at the entry point, and what capabilities a session can see is the consumer's configuration rather than a resolution algorithm AgentForge runs | H6, T5, T6 |
| **D8** | Guardrails a procedure supplies compose with the harness's own, and none is lost to ordering or merging. Their enforcement *semantics* are the consumer's to define | H5, T8, T9, T10, T11 |
| **D33** | Side effects run before the run, and after it on success and on failure, each opt-in per procedure and each surfacing its own failure rather than swallowing it. Recovery when one may have partly happened is the consumer's | T33, T34, both declarations |
| **D9** | The outcome is the agent's last declared answer, taken only once the run has settled with the work it dispatched complete. A run that ends with no answer is an error | H16, T12, T13, T14 |

### Invoking, waiting, recovering

| | Requirement | Sources |
|---|---|---|
| **D10** | Invocation is asynchronous and bounded by no synchronous request limit; a caller can heartbeat whatever it answers to while it waits | H9, T23 |
| **D11** | An outcome survives the caller being redeployed or crashing mid-run | H10, T24 |
| **D12** | A container that dies mid-run is reported as lost within a bounded, knowable time — not at the caller's own timeout | H11, T25 |
| **D13** | Cancelling stops the run, and nothing it started outlives it | H12, T26, T32 |
| **D14** | A retry attaches to a run in progress or already finished; a new attempt starts only once the previous one ended. One execution never runs twice at once | H13, T26 |
| **D15** | Concurrency is the caller's: AgentForge imposes no ceiling of its own and never queues one start behind another. It may refuse a start it cannot run safely, and says so | T27 |

### Identity and state

| | Requirement | Sources |
|---|---|---|
| **D16** | The consumer controls every identifier the platforms expose — isolation, conversation, transcript, working directory — with their distinct meanings intact, and AgentForge carries and records them without imposing a mapping | H14, H15, T28, T29, T30 |
| **D17** | A session started in one container resumes in another | H14, T31 |
| **D18** | Nothing carries from one invocation to the next except state the consumer declared durable, and nothing an invocation started outlives it | T31, T32 |

### Failure

| | Requirement | Sources |
|---|---|---|
| **D19** | Every outcome is typed and every failure carries its cause, distinguishing at least: non-conforming output, budget exhausted, timeout, cancelled, lost, usage limit with its reset time, transient provider error, and harness or SDK error. A lost run is distinguishable from one that failed on its own terms | H17, T20, T21 |
| **D20** | A domain-level negative result — a gate that halts, a rejection — is a successful outcome carrying that answer, never an error | T19 |
| **D21** | A failed attempt is observable to the consumer before its own retry policy acts, with enough identity to act on. Holding it is the consumer's | T22 |

### Recording

| | Requirement | Sources |
|---|---|---|
| **D22** | Every task records the prompt as sent, the resolved options, where the transcript is, usage, timings and every identifier, correlated to the caller's own | H18, T36, T38 |
| **D23** | Traces export over OpenTelemetry and are flushed before the container goes away | H19, T37 |
| **D24** | No credential appears in anything AgentForge emits — log line, error, or recorded value | T35 |

### Building and deploying

| | Requirement | Sources |
|---|---|---|
| **D25** | One code path locally and in the cloud; caller logic does not branch on which, and an unavailable target fails loudly rather than falling back | H20, T39 |
| **D26** | A procedure runs in isolation against a fixture, with no container and no workflow engine | H21 |
| **D28** | A consumer extends the base image with what its procedures need | H23 |
| **D29** | Authentication is the operator's subscription; no pay-per-use key is present, and each deployment reads only the secrets it declares | H24, T44 |
| **D30** | Identifiers AgentForge mints are uuid7 | H25 |
| **D31** | Each deployed agent is resolvable by name, serves the image it was deployed with, and reports liveness without running an agent — and nothing a procedure does delays that report | T40, T41, T42 |
| **D32** | A caller invokes remotely with least privilege — exactly its own agents, and nothing else | T43 |

---

## What AgentForge does not carry, and why

Raised with the operator; each is a wording change in the source contract rather than work here.

| Source | Why not |
|---|---|
| **T2** — timeouts are "not part of a directive's declaration" | The *where* is a mechanism. D6 gives the control the requirement protects, with one authority instead of two |
| **T4** — procedures that invoke no agent | Out of scope: AgentForge runs agents. TrendBot's were a convenience around its git-based working copy and move to its own API layer when it adopts |
| **T5** — capabilities resolving from per-agent and shared scopes by whole-object replacement | Image and mount layout the consumer owns. D7 protects what the session sees at its start |
| **T9** — a date segment in filenames under a root, exempting a scratchpad | TrendBot's file-naming policy in harness clothing. D8 carries the composition; the rule itself is its own hook |
| **T13** — the last submission supersedes "even where the session's final result reports a superseded answer" | Encodes a workaround for specific CLI behavior as permanent contract. D9 states the behavior; §E establishes whether the workaround is still needed |
| **T26** — "one invocation's side effects never commit twice" | Not meetable by AgentForge: a container can die between a side effect and its record. D13 and D14 cover what is meetable; the rest is the consumer's reconciliation |
| **T29, T30** — session-id name mapping and raw-key normalization | Derivations the consumer does before it calls. D16 gives it control of the identifiers themselves |
| **T41** — a last-change time that "moves only when the status does" | A restatement of a platform gotcha. D31 carries the behavior |
| **H14** — "`~/.claude` and the working directory are on the persistent mount" | Names a mechanism; D17 is the behavior. As it happens the mechanism is also where §F is leaning, but the requirement should not fix it |
| **H22** — a change reaching the next run without an image rebuild (was D27) | Withdrawn. Code ships in the image ([ADR 0008](../adr/0008-code-ships-in-the-image.md)); with layered images and affected-only rebuilds, a change deploys only the agent that contains it, and a deploy never interrupts a running session |

---

## What each consumer brings

**StrategyFoundry** — adopting from day one, local first and then AgentCore. Several Claude projects rather than one, with an isolation strategy still to settle; sessions resumable in any container; one image adding Python and NautilusTrader; a usage limit distinct with its reset time, so workflows wait rather than fail; every run's prompt and transcript recorded, because its capital-bearing decisions must be reconstructible.

**TrendBot** — running in the cloud on the predecessor harness today ([lineage](lineage/predecessor-harness.md)). Isolation by entity path or lane, with a session per phase inside it; three deployed agents; a git lifecycle around every run — sync before, commit and push after, nothing on failure — as its own side effect in AgentForge's before and after steps; runs of up to hours; composable fail-closed guardrails; concurrency bounded by the caller.
