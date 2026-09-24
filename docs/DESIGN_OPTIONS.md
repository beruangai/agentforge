# Design Options

What is not yet decided. A question is worked here until it is settled; the outcome then moves to [`ARCHITECTURE.md`](ARCHITECTURE.md), or [`GLOSSARY.md`](GLOSSARY.md) for a term, and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. An open section is marked **[OPEN §x]** where it bites. Do not build against one, and do not resolve one silently.

**Platform behavior AgentForge relies on is settled by testing it** where the documentation is silent, ambiguous or wrong — a spike against the real thing, recorded in [`research/`](research/) before the decision leaves this file. A documented guarantee is trusted and cited, not re-tested (`.claude/rules/testing.md`).

## What is waiting on what

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§F** | Sync cadence and the quiescence threshold; the project-key sanitiser; what a resumed run is missing | Design in the first slice; the resume spike | Session resume and artifacts |
| **§P** | Which S3-compatible server runs locally | Design in the first slice | The first slice's local stack |
| **§E** | Whether background work can be allowed with a deterministic final answer | A spike, when a procedure asks for background work | Nothing — it is off per query |
| **§H** | Whether ids minted in a restored V2 container are unique | A spike on AgentCore, before A2 | A2 |
| **§G** | The admission limit's value | Measured on AgentCore with a real agent run | A2 |
| **§A** | The item shape once a large outcome shares it | Design in the first slice | The first slice's store |
| **§D** | The deploy path: what publishes the leaf image, and what updates only the agents Nx rebuilt | Design, with the constructs | Deployment |
| **§O** | Rotation, and the broker when it arrives | Later; the first slice keeps room | Nothing yet |
| **§N** | The contract hash, the envelope-to-router mapping, and the card generator | Design in the first slice | The first slice |
| **§K** | The plugin and construct surface | Design, after the first agent exists | A2's tooling |
| ~~§B~~ | ~~Whether a busy container receives invocations~~ | **Settled 2026-09-22** — it receives everything, 3/3 ([research](research/agentcore-runtime-observed.md)) | — |
| ~~§C~~ | ~~Cancellation, locally and on the platform~~ | **Settled 2026-09-22**, both halves ([research](research/agentcore-runtime-observed.md)) | — |
| ~~§I~~ | ~~How the A2A server is assembled, and which A2A version~~ | **Decided 2026-09-22** ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), [ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)) | — |
| ~~§L~~ | ~~Where the consumers still pull apart~~ | **Closed 2026-09-23** — §REQ203 settled; the rest ends with the consumer drafts | — |
| ~~§M~~ | ~~Pausing for a human~~ | **Shape decided 2026-09-22** (M2, park as a task state); not built, and no consumer asks | — |
| ~~§N~~ | ~~How a procedure is written~~ | **Decided 2026-09-22** ([ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md)); three consequences open, above | — |

**Open questions are at the top; struck-through rows are closed and kept so a reader can see the answer without opening the section.** §E, §G and §H were settled and are reopened narrowly — §E's background work, §G's admission limit, §H's uniqueness under V2 — the rest of each stands. None blocks starting A1.

---

## §A — Task store details *(the lease and the item shape SETTLED 2026-09-22)*

The interface is fixed and built in the first slice: a conditional insert for the idempotency index, and a fenced write that rejects a stale lease generation, because A2A's `TaskStore.save` overwrites unconditionally. DynamoDB holds the record, and an outcome over 256 KB fails rather than being offloaded (`ARCHITECTURE.md` §4). Open:

- The item shape: what the A2A task, the index, the lease and the outcome look like as one record, and what a poll costs to read
- ~~The lease interval~~ **Decided 2026-09-23: stale at ~60 seconds.**

**Measured** — [`research/agentcore-runtime-observed.md`](research/agentcore-runtime-observed.md) §A, once; not re-tested, because nothing here rests on an undocumented bound. From inside a microVM, on a 236-byte item at a 2-second renewal interval:

- **A write costs the task ~7 ms** (median; 6–67 ms, the outlier being the SDK's first call).
- **A renewal was visible to an eventually-consistent read ~11 ms later**, on the first poll 6 times out of 6. DynamoDB does not document that bound, so the lease is read with `ConsistentRead`, which it does guarantee — 1 RCU instead of half of one.
- **1,800 writes an hour** at 2 s — roughly a fifth of a cent on-demand. The interval could go well below 2 s before the write cost registered against the work it guards.

**So the lease interval is not constrained by the store.** It is constrained by how quickly loss must be noticed, which is a design choice rather than a measurement — and **the choice is ~60 seconds of staleness** (2026-09-23).

Above any plausible renewal stall, so a **false `LOST` is very unlikely** — which matters more than speed here, because `LOST` means side effects may have happened, so a wrong one sends a consumer reconciling for nothing and may run the task twice. A caller polling every 30 s learns within about 90 s. It also sits beside the ~60 s the platform gives a stopped container, so there is one number to hold rather than two. Renewal stays well under it; the renewal *rate* is an implementation detail bounded by cost, and cost is not a constraint at this size.

**This governs one case only.** A replacement container on the same runtime session declares the task lost *immediately* by its own uuid7 mismatch (§H), so the lease matters when no container arrives to notice — the session is gone, and only a reader can tell.

A first attempt polled from a laptop and produced "≈322 ms", which conflated the write, propagation, a 241 ms external read RTT and a 333 ms apparent clock offset. It is recorded in the research note as discarded, not as a figure. **What it does show is that an external reader's own RTT dominates the lease mechanics by more than twenty times**, so where the reader runs matters more than anything the store does.

**Decided 2026-09-22: one task item, plus a tiny index item.** The task item carries the A2A task, the lease and the outcome together, so a poll is a single `GetItem` — 1 RCU while the item stays under 4 KB. A separate small item keyed by the **idempotency key** holds only a pointer to the task id, so the conditional insert is cheap and never contends with the task item. Two keys, one of them on the poll path.

A single item for everything was rejected because the index must be keyed by the idempotency key while the task is keyed by task id: one item cannot be both, and a GSI is eventually consistent and so cannot back a conditional insert. Several items under one partition key were rejected as a Query per poll and the loss of single-item atomicity across the lease and the task.

**Still open:** what a poll costs once a large outcome shares the item, and whether the outcome moves to its own item above a threshold.

## §B — Whether a busy container receives invocations *(SETTLED 2026-09-22)*

`/ping` is a lifecycle signal, not admission control, so a container should receive a start, a poll or a cancel whatever it last reported (`ARCHITECTURE.md` §4). That was inference from the contract's silence, and the whole await path rested on it. **It is now measured** — [`research/agentcore-runtime-observed.md`](research/agentcore-runtime-observed.md), `packages/agentforge/integ/aws/agentcore/busy-container-receives-invocations.test.ts`, `provisioning-window.test.ts`.

- **A busy container receives everything.** With a 25-second task live and `/ping` answering `HealthyBusy`, a second `message/send`, a `tasks/get` and a `tasks/cancel` were all delivered — **3/3, at latencies indistinguishable from an idle session**. The second task ran concurrently in the same container, which reported `liveTasks: 2`.
- **A runtime session id maps 1:1 to a container and stays put.** Six new sessions took six distinct containers; fired again, **6/6** returned the same one. One session's eight calls over ~35 s, spanning an idle gap and a task boundary, all hit one container.
- **A pre-warmed pool was seen once and not again.** On 2026-09-22 containers were up 28–212 s at a session's first call; on 2026-09-24, in `us-east-2`, each session got a fresh container and a first call cost 3.6–5.5 s. Nothing depends on either, so it is recorded, not asserted ([research](research/agentcore-runtime-observed.md)).
- **A session's first call is seconds; every call after ~355 ms.** A caller must tolerate a slow first call and must not size anything on it.
- **The provisioning window produced no 409.** The first invoke, issued 2.9 s after `CreateAgentRuntime` while the control plane still said `CREATING`, **blocked for ~5.8 s and then succeeded**; `READY` was reported at 10.0 s. One session held one container across the transition. **One observation** — enough to say a caller must tolerate a slow first call, not enough to say the documented `RetryableConflictException` never happens, so a client should still retry it.

## §C — Cancellation on the platform *(SETTLED 2026-09-22)*

The mechanism is decided: `CancelTask` reaches the gateway, which stops the task gracefully and then kills its process group, with `StopRuntimeSession` as the blunt fallback (`ARCHITECTURE.md` §4).

**Settled locally** — [`research/task-process-and-cost.md`](research/task-process-and-cost.md), `spikes/task-process/` (retired at A0; in git history at `d3f08b7`):

- The protocol runs over a **dedicated bidirectional socketpair on fd 3** (`"socket-fd"` at stdio index 3, `net.connect({ fd })` at the parent). The task wrote a decoy protocol response to stdout claiming a different outcome and the executor was unaffected, so the separation is real rather than nominal.
- `cancel` over the protocol settles a run gracefully in **5 ms**.
- A task that **ignores `SIGTERM`** — a no-op handler replaces the default disposition — is killed at **511 ms** against a 500 ms grace, `signal = SIGKILL`.
- **`SIGKILL` of the process group takes a grandchild the task started**; the negative control, killing the process alone, left it running. `detached: true` (`setsid`) plus `kill(-pid)` is what makes this true.
- **A cancel arriving before the task process exists** is caught by a token set before the executor's first `await`.

**Settled on the platform** — [`research/agentcore-runtime-observed.md`](research/agentcore-runtime-observed.md), `packages/agentforge/integ/aws/agentcore/stop-runtime-session.test.ts`, `grace-period-after-stop.test.ts`:

- **`StopRuntimeSession` returns 200 in ~390 ms and the container receives a real `SIGTERM` ~400 ms later**, mid-task, with work still in flight.
- **The grace period is fixed at about a minute, and being busy does not extend it.** Two sessions stopped at the same instant — one holding a 4-second task, one a 240-second task — had their containers killed **62.6 s and 61.0 s** after `SIGTERM`. The idle one lived 58 s past the end of its work; the busy one was killed with work still running **while answering `HealthyBusy`**. Across three observations: 56.0 s, 61.0 s, 62.6 s.
- **A stop is not a cancel.** The next invocation on that session id lands on a **fresh container with an empty task store**, so the in-flight task is unreachable from the caller the moment the stop returns — `tasks/get` answered `Task not found` for as long as it was polled.

**The consequence for the design is a budget, not a mechanism: a stopped run has about 60 seconds, then it is gone.** Anything whose recovery cannot finish inside that must not be attempted in the container. This is why `StopRuntimeSession` is the blunt fallback and `CancelTask` is the path — the cooperative cancel settles in 5 ms and keeps the process reachable, which a stop does not.

- **The window is usable.** A container that writes to DynamoDB **from inside its `SIGTERM` handler** succeeded: the row was visible **3.5 s after the stop returned**, written **0 ms after `SIGTERM`**, with a 120-second task still running. Networking, credentials and the store client all survive the signal. So **a stopped run can record its own outcome** rather than being inferred `LOST` by a later reader — which is what makes "a side effect's recovery is the consumer's" implementable here, inside a budget of about a minute.

**Not every termination gets that minute** — documented 2026-09-24: an idle or `maxLifetime` termination "can last up to 15 seconds". Idle cannot catch a running task, because `/ping` answers `HealthyBusy`; the 8-hour lifetime can. A task ended by it may not record its own outcome and is then derived `LOST`. Whether AgentCore can be told not to route a session with too little lifetime left, and what to do if not, is not designed until the metric (`ARCHITECTURE.md` §8) shows it happening.

**Closed 2026-09-23.** Whether the Agent SDK's telemetry flushes inside that window is **moot** — an OpenTelemetry flush on termination is best-effort by construction, and there is nothing AgentForge could do with the answer. §REQ602 asks for a flush before the container goes away, which the cooperative cancel path delivers in 5 ms; the blunt stop is the path where best-effort is the only thing on offer, and that is stated rather than measured.

Three cases the implementation must cover whichever way the spike goes: a cancel arriving **before the task process exists** (settled above); a cancel from a caller that **attached to another caller's task**, which ends it for every attached caller, each of whom knows whether it asked; and a cancel reaching a **freshly provisioned container**, whose A2A SDK would otherwise mark the task cancelled without consulting the executor that owns it.

## §D — Image layering and deploy granularity *(LAYERING AND THE BUILD CHAIN SETTLED; the deploy path OPEN)*

**Settled: [ADR 0008](../adr/0008-code-ships-in-the-image.md) holds.** Measured over a real three-level tree — one AgentForge base, one agentic base, three agents — on the **manifest digests a registry serves**. Findings in [`research/image-determinism.md`](research/image-determinism.md); carried at A0 into `packages/agentforge/integ/local/image-determinism/` and retired from it on 2026-09-24, because nothing AgentForge does depends on them.

- An unchanged rebuild is **byte-identical**: all five digests unmoved across two full rebuilds.
- A change to one agent **does not spread**: `agent-a` moved; `agent-b`, `agent-c` and the agentic base were identical.
- A change to the agentic base **moves all three agents and nothing below**: the AgentForge base image was identical.

So layering behaves as [ADR 0008](../adr/0008-code-ships-in-the-image.md) intended. **What keeps an unaffected agent from being given a new version is Nx, not this** — it is never rebuilt, so nothing about it can move. Digest comparison was the mechanism this section originally proposed and is not AgentForge's to build.

**`bun build` is not a source of drift either** (measured 2026-09-22, Bun 1.4.0, on a real 2.26 MB bundle): byte-identical across runs, across a **different absolute path**, across **changed source mtimes**, and under `--minify` — with a negative control confirming the comparison can fail.

**None of this is load-bearing any more**, and it is worth being clear about that rather than leaving a reader to infer it. Deploy granularity rests on Nx's affected graph (above), not on byte-identity. Reproducibility is still worth having — an image that rebuilds identically from identical inputs is easier to audit and to trust — so the requirements below are kept because they are cheap once known, not because anything breaks without them.

**What determinism requires, isolated by experiment:** `SOURCE_DATE_EPOCH` **and** `rewrite-timestamp=true`. With both, identical; with `SOURCE_DATE_EPOCH` alone, **moved**. The epoch normalises the image config's `created` field and leaves file mtimes in the layers, so **a pipeline setting only `SOURCE_DATE_EPOCH` looks reproducible and is not**. Also required: `--provenance=false`, the **external** base pinned by digest — `oven/bun`, not the local parents, which are static tags Nx keeps current — and no unpinned package installs.

**Three buildx facts, recorded because they cost a day to find**, and because a future reproducibility push will want them: the `docker` driver **cannot export OCI at all**; the `docker` *exporter* does not rewrite layer timestamps, so `docker image inspect --format '{{.Id}}'` **moves on every build** and is useless as a change signal — use buildx's `--metadata-file` `containerimage.digest`; and a `docker-container` builder **cannot see daemon images**, so it cannot resolve a `FROM` against a `--load`ed parent. The last one is why the spike put a throwaway registry between its levels. **None of the three constrains the design**, because the chain builds on the ordinary driver and Nx decides what is rebuilt.

**Still open:**

- **The deploy path.** What publishes a leaf agent image, and what calls `UpdateAgentRuntime` for the agents Nx rebuilt. `@aws/nx-plugin` puts an agent's image in one workspace-wide asset repository through CDK, which does its own asset hashing over the build context — so the honest open question is how much of this is already CDK's and how little AgentForge needs to add.
- **Whether the agent card is generated as a build step** from the image's own registry of procedures.
- **How a runtime is put on platform version V2.** AgentForge runs on V2 (`ARCHITECTURE.md` §5), but CloudFormation and the CDK cannot yet set `platformVersion` ([runtime platform versions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html#runtime-v2-iac), read 2026-09-24), so the construct needs a custom resource calling `UpdateAgentRuntime` until they can. A V2 create or update also takes minutes rather than seconds, which the deploy path waits out.

**Closed, and why:**

- ~~Where `agentforge/a2a-claude` is published and how a consumer pins it~~ **It is not published (2026-09-23).** `@beruangai/agentforge` ships the bundled server and its `Dockerfile`; the consumer builds the base image from `node_modules` as an Nx task, the agentic base is `FROM` it, each agent is `FROM` that, and **only the leaf agent image reaches ECR** — one workspace-wide repository, a CDK construct per agent, following `@aws/nx-plugin` (`ARCHITECTURE.md` §6). There is no package-and-image pairing to assert, because there is one artifact.
- ~~How the local `FROM` chain is built, given determinism needs a builder that cannot see daemon images~~ **Not a conflict — the premise was wrong (2026-09-23).** It assumed AgentForge compares digests to decide what to deploy, which made byte-identity load-bearing and the `docker-container` builder mandatory. **Nx already decides staleness**: each image is a task depending on the task that bundles what it bakes in, an unaffected agent is never rebuilt, and a static local `FROM` tag cannot be stale because the dependency edge guarantees its parent just ran. So the chain builds on the ordinary driver against daemon images, with no registry between levels and no OCI layout. **AgentForge builds no dependency graph, hashing or digest comparison of its own** — duplicating Nx is how two mechanisms drift — and a build outside the task graph is a consumer's or developer's mistake, not a case to detect or support.
- ~~Comparing digests before `UpdateAgentRuntime`~~ **Not AgentForge's mechanism (2026-09-23).** Same reason: Nx decides.
- ~~Task-protocol version negotiation between an executor and a task process built from different artifacts~~ **Moot (2026-09-23).** They cannot be built from different artifacts — the server and the harness both come from `@beruangai/agentforge`. The handshake stays as an assertion that something is badly wrong.

## §E — What the kernel still needs *(SETTLED 2026-09-22, corrected 2026-09-24; background work OPEN)*

Settled by spike against `@anthropic-ai/claude-agent-sdk@0.3.278`, re-run against `0.3.280` — findings, evidence and method in [`research/kernel-settlement.md`](research/kernel-settlement.md); the spikes are now `packages/agentforge/integ/model/kernel-settlement/`. The rules the kernel must follow are in `ARCHITECTURE.md` §7.

- **A final submission survives dispatched work**, in every shape tried — subagents and long tool storms alike. Whether the subagents ran in the foreground was not asserted, and they run in the background by default since CLI 2.1.198, so that is all E1 shows.
- **§REQ206's failure changed shape rather than going away.** On a **streaming-input** session a completing background task starts a new turn and publishes a **second, contradictory result**; the predecessor harness found, besides, `StructuredOutput` called more than once and earlier tool calls dropped by the automatic follow-up turn — so which structured output is final is not deterministic.
- **The kernel is streaming input and output — the operator's decision, 2026-09-24.** A composed prompt is several content blocks, which the string form cannot carry, and only a streaming session reaches `interrupt()`. So closed input, which the first reading of E2 chose, is not an option. **Background work is switched off per query** — `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` through the `env` option, which removes `run_in_background` from Bash and the subagent tool and turns off auto-backgrounding — and the kernel publishes on the first result, then ends its input and reads to process exit.
- **The carrier is a real tool named `StructuredOutput`**, advertised in `init.tools`. A wrong matcher fires zero times, silently.
- **An in-turn rejection adds what the schema cannot express**, and an `updatedInput` repair is 4× cheaper than a denial. A denial loop can end in `subtype: success` with **no output at all**, which the SDK's documentation now also says to treat as a failure.
- **An unknown option key is silently ignored**, so §REQ201's promise is AgentForge's to keep. `maxTurns` and `maxBudgetUsd` end with an **ordinary result** — `terminal_reason: max_turns`, `budget_exhausted` — and only then does the iterator throw; the first reading, that they throw instead of a result, was wrong.

**Open: whether background work can be allowed with a deterministic final answer.** A spike of its own, when a procedure asks for background work. The objective is the final structured output, not detecting that background work is pending or that a second result arrived — both are already detectable (`system/background_tasks_changed`, `result.origin`). Until then it is off per query, and a procedure cannot turn it on.

## §F — The sync declaration and the project key *(direction DECIDED 2026-09-22; the rest of the declaration OPEN)*

Decided: state persists through APIs ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). Transcripts mirror through a `SessionStore`; the config directory is image content; working directories sync to an object store under **a strategy the consumer declares, per agent and overridable per procedure**. AgentForge guarantees the flush-and-verify barrier, the process-group lifetime, and that a sync failure is an outcome.

**The declaration is settled in shape**: the agentic project declares it whole, with every field required so nothing is implicit, and a procedure overrides the fields it differs on. What remains is the fields themselves:

- ~~Direction~~ **Decided 2026-09-22: phased, never concurrent.** A procedure may seed its working directory **down** from the object store before the run, and publish **up** during and at the close. Both directions are available; **both at once are not**, which removes conflict resolution rather than solving it. Last-writer-wins was rejected as a silent discard of work.
- **Deferred, with the answer written down: an on-demand `sync()` callable mid-run.** Not built, because no requirement asks for it: §REQ401 and §REQ402 are met by setting the working directory per procedure and persisting it, and the phased declaration covers everything the register states.

  **The scenario it answers, recorded so it is not re-argued:** a tool that reads or writes the working directory *from outside the container* — another service, a job, a person — needs a push before it is called and a pull after. That is exactly the case the phased declaration cannot express, and it is the only one. Bidirectional continuous sync is still refused; this is a **barrier around a known point**, not concurrent replication, so it needs no conflict resolution.

  **The shape when it is needed: a pair of hooks, not a new object.** A `PreToolUse` hook matching the tool pushes; a `PostToolUse` hook pulls. Both are ordinary composite contributions (§REQ204), so they concatenate with the house set and nothing is lost to ordering, and a procedure that needs the barrier declares it at the call site where a reader can see it. The sync runner already exists for the phased declaration; the hooks call it with an explicit scope. Nothing in the phased declaration forecloses this, so adopting it later costs a helper, not a rearchitecture.
- ~~Delete propagation~~ **Decided 2026-09-23: explicit, no default.** It is expensive to get wrong — a silent delete policy can empty a working directory — so it is stated or the declaration is incomplete.
- Cadence — once at the close, on an interval, or on change — and the quiescence threshold that keeps a file mid-write out of a continuous pass
- ~~Exclusions~~ **Decided 2026-09-23: AgentForge ships the starting list and a consumer opts out of it.** The operator's correction to this section's own wording: "every field is required where it is declared" was aimed at *expensive* settings like direction and delete propagation, and over-reached into everything. A known leak with a known answer is not a choice anyone is making. The field takes `string[] | ((current: string[]) => string[])`, so appending to the default costs a line — and **every field with a house default takes that form**.
- ~~Whether an override may relax what the project tightened~~ **Decided 2026-09-23: the project is a default, not a ceiling.** A procedure overrides any field without ceremony. Tiers, override permissions and distinct verbs for widening are load on the consumer for a problem nobody has. The general rule is in `CLAUDE.md`; **the one exception is where losing a contribution is silent**, which is why guardrail composition stays additive (§REQ204).

**The implementation is checked and it holds** — [`research/working-directory-sync.md`](research/working-directory-sync.md), `packages/agentforge/integ/aws/filesystem-s3-sync/s7cmd-semantics.test.ts`. `s7cmd` **1.8.3** publishes a **musl aarch64** build, which matters because the base image is Alpine and a glibc binary would not run in it; it is **statically linked**, 12.7 MB, and the archive **matched its published sha256**, so "pin it by digest" is actionable. All eight behavioural claims hold against a real bucket, including the three the design rests on: `--filter-mtime-before` **does** skip a file touched moments ago while uploading the settled ones, exclusions work, and **delete propagation is off unless asked for**. One detail with a consequence: the filter takes an **absolute timestamp**, so the quiescence threshold lives in the sync runner and is recomputed each pass rather than declared once to the tool.

**None of that settles the declaration.** The tool can express every option below, so which ones AgentForge *offers* remains a design decision.

**The implementation.** Leading candidate is [`s7cmd`](https://github.com/nidor1998/s7cmd): a single static Rust binary with ARM64 Linux builds, Apache-2.0, bundling the `s3sync` engine — local-to-S3, S3-to-local and S3-to-S3, include and exclude patterns, filtering by `LastModifiedDate` and size, checksum verification, configurable concurrency and a dry run. The `LastModifiedDate` filter is also the quiescence heuristic: sync only what has been still for longer than a threshold, so a file mid-write is left for the next pass. Against it: a personal project whose dependencies are updated best-effort, shipped in our base image and running with credentials — so pin it by digest, and keep an AWS-SDK walk as the fallback if that risk stops being acceptable.

**The project key is decided** (`ARCHITECTURE.md` §6): an AgentForge prefix, `{consumer}_{agenticProject}_{agent}_`, plus a final part **the procedure supplies** — never inferred from a directory. Carried in `CLAUDE_CODE_PROJECT_DIR_NAME`, sanitized to the 1–64 character alphabet that variable allows, and asserted after the run because an invalid name fails silently. What remains is the sanitiser's details: how truncation stays deterministic and stable when a supplied part changes length, and what `CLAUDE_CONFIG_DIR` must be set to alongside it.

**What a resumed run is missing — measured by the resume spike, not assumed** (read 2026-09-24, [research](research/claude-agent-sdk.md)):

- **The config directory is swapped on a resume from the store.** The SDK runs the CLI against a temporary `CLAUDE_CONFIG_DIR` seeded with credentials, `.claude.json` and the user `settings.json` alone, so what the base image put at the user scope (§L) may be absent. If the spike shows a resumed session degraded, **AgentForge syncs the subset of the config directory it needs through the same object-store sync as a working directory** — wholly AgentForge's, with nothing for a consumer to declare. The S3 Files mount earlier drafts planned for this was dropped with the VPC it required ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)).
- **A mid-turn death loses that turn's entries**, because the store flushes at the end of a turn by default. Accepted, not hardened against: it is counted (`ARCHITECTURE.md` §8), and `'eager'` flushing is the answer if the count says it matters.
- **A resumed session keeps its system prompt**, and reports cost for the whole session; §REQ201 and `ARCHITECTURE.md` §8 say what that means for AgentForge.

**The remaining edges**, whatever is declared: when a file is quiescent enough to upload so a half-written file is not published; how writes are coalesced so a tool loop is not a request storm; and what a caller sees when a run is lost mid-sync, which is partial artifacts already visible — consistent with `LOST` meaning side effects may have happened, but worth writing down rather than discovering.

## §G — Health and per-task cost *(SETTLED 2026-09-22; the admission limit's value OPEN)*

Measured; [ADR 0004](../adr/0004-a-process-per-task.md) confirmed. Findings in [`research/task-process-and-cost.md`](research/task-process-and-cost.md), spike retired at A0 — `spikes/task-process/` in git history at `d3f08b7`.

- **`/ping` is untouched by running tasks.** Four tasks, two of them saturating a core, moved p95 not at all: 1.32 ms idle against 0.18 ms busy. §REQ707 holds by construction, because the tasks are separate processes.
- **A process per task costs 65 ms** ready-to-serve with the Agent SDK imported (15 ms without) — **0.054 %** of a 120-second run.
- **Per-task fixed memory is tens of megabytes**, ≈ 61 MB RSS, so the admission limit will be governed by what an agent run costs rather than by the process-per-task decision. The limit itself is **not** derived from this number: the fixture does not spawn the Claude Code CLI a real task spawns, and a limit set from a harness floor would err in the unsafe direction. **Open: the value**, measured on AgentCore with real agent runs — what one costs in memory at its peak, with its CLI, shells and MCP servers — before A2 sets a default.

## §H — Container identity *(SETTLED 2026-09-22; minting moved 2026-09-24; uniqueness under V2 OPEN)*

The key, its two edges and its retention are settled: seven days, with the key scoped to the caller's run so nothing re-sends it afterwards ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md), `ARCHITECTURE.md` §4). What remains:

- **Decided 2026-09-22: a uuid7 minted per container.** Each container mints an id **on its first request** — moved there from process start on 2026-09-24, because on platform version V2 every container is restored from one snapshot taken after startup, and a value minted at start is then the same in every container — and writes it with the lease. A later container serving the same runtime session sees a different id and declares the task lost **immediately**, without waiting for the lease to expire. Measured support: one runtime session maps to exactly one container and stays pinned, and a stopped session's next invocation lands on a **fresh** container with no memory of the task — so an id mismatch is a reliable signal rather than a heuristic ([research](research/agentcore-runtime-observed.md)).

  AgentCore's own identifiers were rejected because the runtime session id is **stable across container replacement**, which is precisely the case that must be detected. Relying on the lease alone was rejected because it bounds recovery below by the lease interval, which is the delay this exists to remove.

**Open: whether an id minted after a restore is unique.** AgentCore's V2 guidance is that a cryptographic library which cached random state before the snapshot can hand every restored instance the same values, and that a container image must use a snapshot-safe build that reseeds after a restore ([optimize for V2](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-v2-optimize.html), read 2026-09-24). Whether Bun's random source reseeds is not documented. Every uuid7 AgentForge mints in a container — the container id, a `contextId` the caller did not supply — depends on it, and a collision would be silent. **A spike on AgentCore before A2**: restore several containers from one snapshot, mint in each, and compare; if they collide, the image supplies a reseeding source.

## §I — How the server is assembled, and which A2A version *(SETTLED 2026-09-22)*

**Decided:** assemble directly from `@a2a-js/sdk` and Express, porting `serveA2A`'s AgentCore-contract mechanics rather than depending on it — [ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md). Findings in [`research/a2a-server-assembly.md`](research/a2a-server-assembly.md); the spike, `spikes/server-assembly/i1-gateway-wrap.ts`, was retired at A0 — its mechanics become the real gateway — and is in git history at `d3f08b7`. **The first slice is unblocked.**

`serveA2A` was excluded on two independent grounds: its options take an **executor and no request handler**, and `buildA2AApp` constructs `DefaultRequestHandler` itself — so there is no seam for a gateway, which does not change when it publishes; and it is not in `bedrock-agentcore@0.4.4`, still the latest published version on 2026-09-24. The gateway shape itself was confirmed in full: `returnImmediately` resolved in 8 ms against a 6 000 ms run on a synchronously published `submitted`, and blocked for exactly the deferral when the publish was withheld; a duplicate idempotency key returned the running task with the executor started once; a uuid7 `contextId` returned verbatim; cancel reached the executor; admission refused rather than queued; and a client built from a known card signed through `JsonRpcTransportFactory`'s `fetchImpl` without fetching a card.

Two constraints found along the way, both recorded in the research note: **`@a2a-js/sdk@1.2.0` is protobuf-typed**, so a part written the way the specification documents it serializes to an empty part with no error; and **an absent `A2A-Version` header means protocol 0.3**, so anything that drops it downgrades the request.

**Answered against AgentCore** — [`research/agentcore-runtime-observed.md`](research/agentcore-runtime-observed.md), `packages/agentforge/integ/aws/agentcore/__fixtures__/server.ts`, `a2a-1-0-only-through-agentcore.test.ts`:

- **`A2A-Version` is not forwarded *by default*, but it can be allowlisted.** AgentCore takes a per-runtime `requestHeaderConfiguration.requestHeaderAllowlist` (up to 20 headers, 4 KB each) on `CreateAgentRuntime`/`UpdateAgentRuntime`; `A2A-Version` breaks none of its restrictions. Measured: with it allowlisted, `A2A-Version: 1.0` **arrives and negotiates 1.0**; without the allowlist entry the header is dropped and 0.3 is negotiated; a header not on the list never arrives. **So AgentForge is not pinned to 0.3** — the opposite of what the first version of this section recorded — and the choice was made: 1.0 only (below).
- **A part reader must throw on a part it cannot decode.** The failure is real but its trigger is narrower than first written: under the **1.0 RPC method name `SendMessage`**, a part in the SDK's internal protobuf shape is accepted with its `content` silently dropped — with or without `A2A-Version: 1.0`. Under `message/send` the same part is properly rejected. `{ kind: 'data', data }` is the wire shape in both versions and always works. One combination therefore delivers an empty envelope and calls it success, which is a zero-silent-failures requirement on the harness, not a nicety.
- **A client-supplied uuid7 `contextId` survives the pass-through verbatim.**
- **`GetAgentCard` serves the container's own card**, not a synthesised one — except `url` and every `supportedInterfaces[].url`, which the platform **rewrites** to the invocations endpoint. So the container must not be relied on to declare its own public URL.
- **424 is what a container-side error looks like from outside**, carrying `-32055 "Runtime client error - Please check your CloudWatch logs"` and naming neither the header nor the cause — so the client must surface the request id and the caller must be told to read the logs. **No 409 was observed** even when invoking through the provisioning window (§B), though the documented retry is still worth keeping.
- **1.0 only, with no 0.3 anywhere — the operator's direction on 2026-09-22, and it is achievable. Recorded as [ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md).** A2A is AgentForge's transport and is never exposed to a consumer or an agent, so there is no caller to stay compatible with. Measured: a card declaring a single 1.0 interface with `legacyCompat` **off** answers every 0.3 request with `-32009 … version '0.3' is not supported`, and answers `A2A-Version: 1.0` + `SendMessage` correctly. The SDK's own client, built from that card, sends the header and the 1.0 method name **by itself** — so it is configuration at both ends, not code. **The misconfiguration mode is the right way round:** with `legacyCompat` off a missing allowlist entry fails on the first invocation instead of silently running 0.3. (An earlier version of this bullet argued for keeping `legacyCompat` on as a safety net. That was backwards and is withdrawn.) Confirmed end to end through AgentCore, not inferred from two halves. Three consequences: **1.0 uses the protobuf RPC names** — `SendMessage`, `GetTask`, `CancelTask` — and a different wire encoding (`role: "ROLE_USER"`, a data part as `{ data: {…} }` with no `kind`), so every spike written before this used 0.3 shapes; **the part-reader guard matters more, not less**, because the silent strip below is triggered by `SendMessage` itself; and **the rejection a 0.3 caller sees is opaque** — AgentCore wraps the container's `-32009` as HTTP 424 `-32055`, indistinguishable from a crash. That argues for the client asserting the negotiated version it got back rather than inferring success from a 200.
- **`@a2a-js/sdk` 1.2.1 changes three things measured here** (merged, not yet published on 2026-09-24): a refused `A2A-Version` and other errors raised before a request is handled come back as HTTP **200** rather than 500, so AgentCore no longer wraps them as an opaque 424; a request is routed by its `A2A-Version` header rather than its method name, so a `SendMessage` with no header is a 0.3 method error rather than a silent strip; and metadata published on status and artifact update events reaches the stored task, which 1.2.0 drops silently. ADR 0014's decision stands; its reason for asserting the negotiated version gets weaker, and the integration tests pinning the 424 and the strip change with the bump.
- **The caller must set `contentType: 'application/json'`.** AgentCore forwards the caller's content type unchanged; `@aws-sdk/client-bedrock-agentcore` defaults to `application/octet-stream`, which `jsonRpcHandler` rejects. An earlier note claiming AgentCore *strips* content-type was wrong and is corrected in the research note.

## §P — Local stores *(DynamoDB Local DECIDED 2026-09-24; the object store OPEN)*

**Decided 2026-09-24: locally, the stores are the cloud's, in Docker.** Task state is in **DynamoDB Local**, reached through the same store implementation the cloud uses with only its endpoint changed. A filesystem task store, which A1 first planned, would have been a second implementation of the fencing and the conditional insert — exactly the rules most likely to drift — for a local path §REQ701 says is not a mock.

**Open: which S3-compatible server holds objects locally** — transcripts through the `SessionStore` adapter, and working directories through the sync runner. It must accept the AWS SDK's S3 client and `s7cmd` with only an endpoint override, run as one container, and be maintained. Settled in the first slice's design, with a check that `s7cmd`'s `--filter-mtime-before` and delete propagation behave against it as they do against S3.

## §K — The plugin and construct surface *(DEFERRED 2026-09-22 — until the first agent exists)*

Delivered as an Nx plugin with generators, constructs and a deploy path ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). **Confirmed deferred 2026-09-22:** the first real agent is built by hand against the runtime and harness, and the generators then encode what it actually needed rather than what was guessed. One input is already fixed by §L — each image layer owns a `.claude/` directory, and the plugin generates that layer's scaffolding. Open:

- Which generators exist and what each writes: an agentic project, an agentic base image, an agent over it, a procedure, a caller's wiring
- **The sync generator** — what it keeps current as AgentForge changes (wiring, construct props, the caller's client, image pins), how it reports a change it cannot make automatically, and how much of `@aws/nx-plugin`'s own sync machinery is reused
- What each construct covers, what a consumer supplies, and how several agents share or separate stores, buckets and the registry
- The AppConfig runtime configuration an agent's ARN is published into, following `@aws/nx-plugin` ([research](research/aws-nx-plugin.md)): its schema, what the identity triple keys, caching and refresh, and what a long-lived caller such as a Temporal worker pays to read it (§REQ707, §REQ708)
- Whether the generated client factory mirrors its `.local()` / `.withIamAuth()` shape

## §L — What a session sees at its start *(SETTLED 2026-09-22; the rest CLOSED)*

- **~~What a session sees at its start (§REQ203).~~ DECIDED 2026-09-22 — capabilities compose by image layer; settings do not.** Each layer owns one `.claude/` at its own level and the Agent SDK composes **skills, commands, subagents, `CLAUDE.md` and rules** by walking up from `cwd`: the base image at the user scope, the agentic project's image at its level, each agent's image at its own, a procedure below that. A nearer layer overrides a further one by name; there is no build-time composition step. Both consumers become the same mechanism at different settings, with no branch in the harness. Each layer's code ships the filesystem it wants copied into the image it owns, and the Nx plugin generates that layer's scaffolding. Writing outside your own layer's area is discouraged, not prevented. ([research](research/capability-composition.md); established in the predecessor harness.)

  **`settings.json` and hooks do NOT compose** — only `<cwd>/.claude/` and the user scope are read, with no parent fallback. **An image layer cannot grant itself permissions or install a hook from its own directory level.** So per-layer and per-procedure settings come from the SDK's **`settings` option**, which populates the flag-settings layer in the precedence order and is passed per query. A run is one query, so nothing needs to change settings mid-session. That is how Read/Write permissions are scoped to whatever context a procedure was asked for, and it means **AgentForge composes the settings itself and passes them inline**, rather than relying on the filesystem for them.

  **Two layout rules follow, both silent when broken:**
  - **Skills, commands and subagents stop at a repository root.** Every capability layer must sit below any `.git` in the chain, or repositories must stay out of it. A layer simply does not appear — which earns a startup assertion that the expected layers actually loaded.
  - **An additional directory's filesystem permissions are declared explicitly, in `settings`.** Read and write access for a working directory is load-bearing, so it is stated rather than implied — explicit wins. A working directory carries **no nested `.claude/`**: that is a standing assumption, not something to enforce or work around, and a use case that wants otherwise would be deliberate and does not exist yet.

**The rest of this section is closed, 2026-09-23.** It tracked where the two consumer drafts still pulled apart — holding a failed attempt (§REQ503), and the split on secrets (§REQ705). Those drafts are closed and [`REQUIREMENTS.md`](REQUIREMENTS.md) is now AgentForge's own register: §REQ503 and §REQ705 stand as written there, and anything further enters through the operator as a requirement rather than as a divergence to reconcile.

## §M — Pausing for a human *(SHAPE DECIDED 2026-09-22; not built, and no consumer asks)*

Neither consumer requires it, so nothing is built. It is here because the shape should be decided rather than fall out of whichever case ships first.

**The agent never learns how a human was reached.** The trigger is the SDK's own permission interrupt, which the harness turns into an A2A pause; the caller waits however it likes, and nothing below the client knows a workflow and a signal were involved.

- **M1 — Block in place.** The interrupt blocks while `/ping` reports `HealthyBusy`. Keeps the turn's context and the pending tool call; costs a held process and session, and cannot outlive the 8-hour job cap.
- **M2 — Park as a task state.** The task moves to `input-required` carrying the request and the schema of its answer; the run ends at a step boundary; the answer arrives on a later send against the same task. Unbounded and cheap; loses the in-flight tool call, and resumes through session resume rather than mid-turn.
- **M3 — Both**, per pause point.

**Decided 2026-09-22: M2, park as a task state.** It fits the asynchronous premise, costs no held process or session, and is unbounded. It loses the in-flight tool call and resumes through session resume rather than mid-turn, which is the price. M1 was rejected on measurement as much as principle: a container is killed about sixty seconds after a stop whatever it is doing, `HealthyBusy` does not extend that, and nothing can outlive the eight-hour job cap — so a long human delay would fail rather than wait. M3 is two mechanisms for a feature no consumer has asked for. **Still not built** — the shape is decided, the work waits for a requirement.

Four rules hold whichever is chosen ([reference](research/harness-references.md)): the request carries the **schema of the answer**, validated at the boundary; a malformed answer is rejected **without consuming the pause**; pending pauses appear in the task's own state as well as on the stream; and the surface that resolves a pause is **not on the agent card** beside ordinary procedure calls.

## §N — How a procedure is written *(DECIDED 2026-09-22; three consequences OPEN)*

**Decided: oRPC, contract-first** — [ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md). Findings in [`research/procedure-framework.md`](research/procedure-framework.md); spikes now `packages/agentforge/integ/local/procedure-framework/`. The earlier comparison of three hand-built styles stands as evidence ([`research/procedure-authoring.md`](research/procedure-authoring.md), `spikes/procedure-authoring/`, retired at A0, git history `d3f08b7`) but not as the decision: it asked which shape to build, never whether to build at all.

- **The crux is the split, and it holds.** A consumer declares one contract; a utility derives **`SendMessage`** and **`GetTask`**, named as A2A names them and typed with that procedure's own shapes. **`CancelTask` is root-level**, not per procedure — a task id and a runtime session are the caller's, so nothing about it is the contract's. Proved under `tsc --strict` with probes plus a negative control.
- **`GetTask` is one call, and returns a discriminated union.** An earlier draft had a `submit`/`result` pair, which left a caller polling a running task with nothing to read. `GetTaskRequest` is `{ id, historyLength? }` and returns the whole task with **no artifact filter**, so a separate `outcome` call would be a second name over one wire call returning identical bytes. Narrowing on `state` flows through the link: the declared output is reachable only on the `TASK_STATE_COMPLETED` branch, and each procedure's `GetTask` carries **its own** output type, not a shared one.
- **The two per-call values are enforced separately.** `ContractRouterClient` applies one context to a whole router, so AgentForge applies it **per call** in the client type it vends: `runtimeSessionId` on every call, `idempotencyKey` on `SendMessage` alone. Proved — a start without a key does not compile, and a poll is not asked for one.
- **The transport stays ours.** A custom client link carries a call over A2A with no HTTP anywhere, and the client is still typed from the contract alone — three probes plus a control.
- **Typed context is the thing hand-built authoring could not give us.** Middleware contributes a value; every later middleware and the handler see it typed, with no cast and no declaration on the procedure. This is the tRPC capability TrendBot relies on and the reason to adopt rather than build.
- **Errors keep their fidelity.** Message, structured `data` and the original stack survive a serialising transport, so nothing is marshalled behind a developer's back.
- **Streaming and cancellation both work over a custom link** (spiked 2026-09-23). Three events crossed a real byte boundary interleaved rather than buffered; a signal reached middleware and handler as the same object and a 5 000 ms run returned in 64 ms. Two things are AgentForge's rather than the framework's: the **wire encoding** for a stream, and mapping a caller's abort onto the out-of-band `CancelTask` (`ARCHITECTURE.md` §3).
- **Client context is where the idempotency key belongs.** `ClientLink<T>` types what a caller supplies per call, separately from the input, so the compiler requires a key on every submit without any procedure declaring one (`ARCHITECTURE.md` §4). The requirement is carried by the **client's** type, so AgentForge vends that type and a consumer never writes it.
- **`Locking` is not adopted.** `@orpc/experimental-lock` is a mutex that stores no result, so a repeat does not get the first answer back; AgentForge needs the same *task* returned across containers after the first has died, which is the conditional insert already in the design (§REQ103). Its non-memory adapters are all Redis-family, which AgentForge does not have.

**Three things the adoption opens, none blocking, none previously written down:**

- **How the contract hash is derived from an oRPC contract.** It was to be computed over the Zod schemas; the contract is now an oRPC object wrapping them. The hash must cover exactly what a container must implement — the input and output schemas and the procedure name — and must be stable across an oRPC patch version, or every bump refuses every task. It is load-bearing: an unknown hash is a `TASK_STATE_REJECTED` task (`ARCHITECTURE.md` §4).
- **How an A2A envelope reaches an oRPC handler.** The gateway decides admission from the envelope *before* a task id exists (`ARCHITECTURE.md` §4); the oRPC router then executes the procedure in the task process. Where the router sits relative to the gateway, and how the envelope's procedure name becomes a router path, is unwritten. `call()` in-process is the mechanism; the mapping is the design.
- **What the agent card is generated from.** It is built from the procedures an image contains (`ARCHITECTURE.md` §6). That registry is now an oRPC router, which can be walked — but the card is A2A, not OpenAPI, so the generator is ours.

**On the hand-built comparison, the findings still hold.** All three styles caught all six composition mistakes under `tsc --strict`; the class has one unguarded hazard — `override guardrails() { return []; }` silently drops every house guardrail and `tsc` accepts it — which is why **guardrail composition stays additive** here regardless of framework.

**Closed, not open.** An earlier draft of this section reopened whether AgentForge should carry procedures that invoke no agent, on the grounds that co-location is a reason "put it in the consumer" does not answer. **It is settled and not reopened**: AgentForge runs agents (`ARCHITECTURE.md` §11, `SOLUTION_SPACE.md`). Co-location is a reason to want one, not a reason for AgentForge to grow a second procedure kind.

## §O — Credentials in the container *(the first slice DECIDED 2026-09-22; the broker OPEN)*

The Agent SDK reads the subscription token from the environment and offers no provider interface, so that token stays there. The question is everything else: the provider API keys a procedure's tools need, which arrive from a secret store through AgentCore Identity and would otherwise sit in the same environment the agent's own shell can read.

- **Decided: the environment now, a proxy later.** The subscription token and a procedure's provider keys reach the container from a secret store through AgentCore Identity and live in the environment, where the agent's own shell can read them. That exposure is recorded rather than mitigated in the first slice; the base image keeps room for a broker in the shape of something like Infisical's agent-vault. Open is what the broker would look like when it arrives, and what the first slice must avoid doing to keep it cheap.
- **Decided 2026-09-22 — the first slice classifies expiry and nothing more.** `CREDENTIAL_EXPIRED` is a distinct outcome so an expired token never surfaces as a transient provider failure, which the zero-silent-failures rule requires and which is cheap. The in-microVM exposure and the broker's eventual shape are recorded rather than mitigated. Rotation and the broker stay open.
- How expiry is detected in practice, given the SDK surfaces it as an ordinary error
- Rotation, and how a new key reaches a task that started before it changed
- What a compromised or prompt-injected procedure can reach inside the microVM, and what is therefore not defensible by scrubbing an environment

---

## Tabled

Not open questions — deliberately not being worked until something asks for them.

- **Mounted filesystems, and the VPC they require.** Both consumers are served by the sync mechanism, so AgentForge supports no mount today. A consumer that needs live shared POSIX configures one in its own CDK; making it first-class means the whole VPC surface — NAT, endpoints, allow-listed availability zones, mount-target alignment, paired 2049 rules, ENI lifecycle — and waits for an explicit requirement.

---

## Spike plan

**A spike lands as an integration test when its answer can drift** (`ARCHITECTURE.md` §9) — a platform or dependency behaviour is not self-renewing, so it keeps being checked; a question settled once is recorded in an ADR or a research note with its date. `spikes/` itself was retired at A0: each spike above is now a test in `packages/agentforge/integ/`, or retired with its finding kept in the research note. AgentCore tests run against a throwaway runtime, never a deployment, and stub the model call so they stay cheap and deterministic.

| Spike | Answers | State |
|---|---|---|
| Kernel settlement and structured output | §E | **done** — `packages/agentforge/integ/model/kernel-settlement/` |
| Task-process protocol, cancellation, group kill | §C, §G | **done** — retired at A0 ([ADR 0004](../adr/0004-a-process-per-task.md)); git history `d3f08b7` |
| Procedure framework: the split, custom link, typed context, streaming, cancellation | §N | **done** — `packages/agentforge/integ/local/procedure-framework/` |
| A2A server assembly, the wrapping gateway, client signing | §I | **done** — retired at A0; the gateway's own tests replace it; git history `d3f08b7` |
| Image layering and bundler determinism | §D | **done** — retired on 2026-09-24; findings in [`research/image-determinism.md`](research/image-determinism.md) |
| Capability composition up the image chain | §L | **done** — `packages/agentforge/integ/local/capability-composition/` |
| Working-directory sync semantics | §F | **done** — `packages/agentforge/integ/aws/filesystem-s3-sync/` |
| Busy-container reachability, concurrency, container-per-session | §B | **done** — `packages/agentforge/integ/aws/agentcore/`; container-per-session is AgentCore's documented guarantee and not re-tested |
| Cancellation, the stop grace period, the outcome inside it | §C | **done** — `packages/agentforge/integ/aws/agentcore/` |
| Task store lease and visibility, from inside a microVM | §A | **done** — measured once, [`research/agentcore-runtime-observed.md`](research/agentcore-runtime-observed.md) §A |
| Header allowlist, 1.0-only negotiation, the silent part strip | §I | **done** — `packages/agentforge/integ/aws/agentcore/` |
| **Session resume across containers** | §F | **not run** — needs a real agent in a container, so it waits for A1; covers what a resumed run is missing from the swapped config directory |
| **Uniqueness after a V2 restore** | §H | **not run** — before A2 |
| **Background work with a deterministic final answer** | §E | **not run** — when a procedure asks for background work |

**Everything else is answered.** Credential provisioning was on this list and is not a spike: §O's first slice classifies `CREDENTIAL_EXPIRED` and does nothing more, which needs no measurement. The one outstanding spike needs an agent that does not exist yet, so **no spike blocks A0**.
