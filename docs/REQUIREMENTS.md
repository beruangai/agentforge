# Requirements

**What AgentForge answers to.** This register is AgentForge's own — it is the contract, not a derivation of one.

It began as a distillation of two consumer drafts, StrategyFoundry's and TrendBot's. Those drafts are **closed**: what was settled from them is folded in below, and AgentForge no longer reads, tracks or enforces them. A consumer that needs something new raises it with the operator, and it enters here as a requirement of AgentForge's — not as a clause in a document elsewhere that this repository must stay in step with.

## Rules

- **A capability no requirement here asks for is not built.** Every proposal traces to a D id.
- **A requirement states behavior, never mechanism.** How it is met is AgentForge's, entirely.
- **One consumer's need is met by configuration, or by a helper it calls** — never by a branch in the harness or the runtime.
- **The consumer owns its isolation strategy and its side effects**, including recovery when one may have partly happened.
- **No consumer vocabulary enters AgentForge.** A StrategyFoundry *directive* and a TrendBot *directive* are both a **procedure**; a *vault* is a working directory.
- **A breaking change here is reviewed with the operator** against both consumers, once, rather than negotiated twice.

---

## What AgentForge answers to

### Declaring and typing

| | Requirement |
|---|---|
| **D1** | A caller invokes a procedure by name with typed input and receives a typed outcome. A wrong name or shape fails at compile time; there is no per-procedure wiring |
| **D2** | A procedure declares an outer contract and, separately, what the agent itself fills in. Computed fields and identifiers are added between them, never asked of the model |
| **D3** | Input and output are structured throughout, and parsing is strict in both directions and at every boundary. A non-conforming output fails loudly with its payload preserved — no coercion, no partial delivery, no silent drop — and field descriptions reach the agent with its schema |
| **D4** | A container that cannot serve the contract a caller compiled against refuses the task before any work, naming what it could not resolve |

### Controlling the run

| | Requirement |
|---|---|
| **D5** | Every option a procedure sets reaches the SDK, or the task is rejected. Nothing accepted is silently dropped |
| **D6** | A consumer controls a run's time budget and it is enforced. *Where* it is declared is AgentForge's: one budget per task, declared with the procedure and overridable per invocation, so a caller that sizes budgets per call is served without a second authority over when a run ends |
| **D7** | A session starts from exactly what the procedure composed. Nothing is discovered at the entry point, and what capabilities a session can see is the consumer's configuration rather than a resolution algorithm AgentForge runs |
| **D8** | Guardrails a procedure supplies compose with the harness's own, and none is lost to ordering or merging. Their enforcement *semantics* are the consumer's to define |
| **D33** | Side effects run before the run, and after it on success and on failure, each opt-in per procedure and each surfacing its own failure rather than swallowing it. Recovery when one may have partly happened is the consumer's |
| **D9** | The outcome is the agent's last declared answer, taken only once the run has settled with the work it dispatched complete. A run that ends with no answer is an error |

### Invoking, waiting, recovering

| | Requirement |
|---|---|
| **D10** | Invocation is asynchronous and bounded by no synchronous request limit; a caller can heartbeat whatever it answers to while it waits |
| **D11** | An outcome survives the caller being redeployed or crashing mid-run |
| **D12** | A container that dies mid-run is reported as lost within a bounded, knowable time — not at the caller's own timeout |
| **D13** | Cancelling stops the run, and nothing it started outlives it |
| **D14** | A retry attaches to a run in progress or already finished; a new attempt starts only once the previous one ended. One execution never runs twice at once |
| **D15** | Concurrency is the caller's: AgentForge imposes no ceiling of its own and never queues one start behind another. It may refuse a start it cannot run safely, and says so |

### Identity and state

| | Requirement |
|---|---|
| **D16** | The consumer controls every identifier the platforms expose — isolation, conversation, transcript, working directory — with their distinct meanings intact, and AgentForge carries and records them without imposing a mapping |
| **D17** | A session started in one container resumes in another |
| **D18** | Nothing carries from one invocation to the next except state the consumer declared durable, and nothing an invocation started outlives it |

### Failure

| | Requirement |
|---|---|
| **D19** | Every outcome is typed and every failure carries its cause, distinguishing at least: non-conforming output, budget exhausted, timeout, cancelled, lost, usage limit with its reset time, transient provider error, and harness or SDK error. A lost run is distinguishable from one that failed on its own terms |
| **D20** | A domain-level negative result — a gate that halts, a rejection — is a successful outcome carrying that answer, never an error |
| **D21** | A failed attempt is observable to the consumer before its own retry policy acts, with enough identity to act on. Holding it is the consumer's |

### Recording

| | Requirement |
|---|---|
| **D22** | Every task records the prompt as sent, the resolved options, where the transcript is, usage, timings and every identifier, correlated to the caller's own |
| **D23** | Traces export over OpenTelemetry and are flushed before the container goes away |
| **D24** | No credential appears in anything AgentForge emits — log line, error, or recorded value |

### Building and deploying

| | Requirement |
|---|---|
| **D25** | One code path locally and in the cloud; caller logic does not branch on which, and an unavailable target fails loudly rather than falling back |
| **D26** | A procedure runs in isolation against a fixture, with no container and no workflow engine |
| **D28** | A consumer extends the base image with what its procedures need |
| **D29** | Authentication is the operator's subscription; no pay-per-use key is present, and each deployment reads only the secrets it declares |
| **D30** | Identifiers AgentForge mints are uuid7 |
| **D31** | Each deployed agent is resolvable by name, serves the image it was deployed with, and reports liveness without running an agent — and nothing a procedure does delays that report |
| **D32** | A caller invokes remotely with least privilege — exactly its own agents, and nothing else |

---

## Who it serves

Two consumers, both TypeScript on Bun and orchestrated by Temporal.

**StrategyFoundry** — adopting from day one, local first and then AgentCore. Several Claude projects rather than one; sessions resumable in any container; an image adding Python and NautilusTrader; every run's prompt and transcript recorded, because its capital-bearing decisions must be reconstructible.

**TrendBot** — running in the cloud today on its own [predecessor harness](lineage/predecessor-harness.md), which shares this name and is not this. Isolation by entity path or lane with a session per phase inside it; three deployed agents; a git lifecycle around every run as its own before and after steps; runs of up to hours; composable fail-closed guardrails.

Neither is a source of requirements any more. Both are why these exist.
