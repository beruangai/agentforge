# Design Options

What is not yet decided. A question is worked here until it is settled; the outcome then moves to [`ARCHITECTURE.md`](ARCHITECTURE.md), or [`GLOSSARY.md`](GLOSSARY.md) for a term, and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. Sections are marked **[OPEN §x]** at their points of use, except §L. Do not build against one, and do not resolve one silently.

**Platform behavior is settled by testing it** — a spike against the real thing, recorded in [`research/`](research/) before the decision leaves this file. Nothing here is settled by reading documentation.

## What is waiting on what

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§I** | How the A2A server is assembled | **Decided 2026-09-22** ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), proposed); AgentCore pass-through still open | The first slice |
| **§A** | Task store details behind the fixed interface | Design in the first slice; one AgentCore spike | The first slice's store |
| ~~§N~~ | ~~How a procedure is written~~ | **Decided 2026-09-22** ([ADR 0013](../adr/0013-a-procedure-is-an-object-literal.md), proposed) | — |
| ~~§E~~ | ~~What the kernel still needs to settle a run~~ | **Settled 2026-09-22** ([research](research/kernel-settlement.md)) | — |
| **§C** | Cancellation on the platform | Local half **settled 2026-09-22**; platform half **blocked** with §B | Cancel on AgentCore |
| **§O** | What a credential broker looks like when it arrives | Later; the first slice keeps room | Nothing yet |
| **§F** | The sync declaration's fields, and the key's derivation | Design in the first slice | Session resume and artifacts |
| **§B** | Whether a busy container receives invocations | AgentCore spike — **blocked on `iam:PassRole`** (§B) | The await path on AgentCore |
| **§D** | Image determinism and deploy granularity | Layering **settled 2026-09-22** ([research](research/image-determinism.md)); bundler determinism open | Deployment |
| ~~§G~~ | ~~Health and per-task cost~~ | **Settled 2026-09-22** ([research](research/task-process-and-cost.md)) — ADR 0004 confirmed | — |
| **§H** | Container identity in the record | Design in the first slice | Loss detection on retry |
| **§K** | The plugin and construct surface | Design, after the first agent exists | A2's tooling |
| **§L** | Where the consumers still pull apart | **Operator**, with each consumer | A3 |
| **§M** | Pausing for a human | **Operator** — whether to support it at all | Nothing yet |

---

## §A — Task store details *(OPEN)*

The interface is fixed and built in the first slice: a conditional insert for the idempotency index, and a fenced write that rejects a stale lease generation, because A2A's `TaskStore.save` overwrites unconditionally. DynamoDB holds the record, and an outcome over 256 KB fails rather than being offloaded (`ARCHITECTURE.md` §4). Open:

- The item shape: what the A2A task, the index, the lease and the outcome look like as one record, and what a poll costs to read
- The lease interval — short enough that loss is noticed, cheap enough at the renewal rate a long run implies

**Spike (AgentCore):** write and renew a lease from inside a microVM, read it from outside, and measure visibility latency and renewal cost at the chosen interval.

## §B — Whether a busy container receives invocations *(OPEN — BLOCKED on IAM, 2026-09-22)*

> **Blocked, not unanswered.** The AgentCore half of the spike plan — §B, §C's platform half and §A's lease measurement — could not run on 2026-09-22. `CreateAgentRuntime` requires `--role-arn`, and the `agentforge` SSO profile is `AWSReservedSSO_PowerUserAccess`, which denies both `iam:CreateRole` and, decisively, **`iam:PassRole`**:
>
> ```
> AccessDeniedException: User: …/AWSReservedSSO_PowerUserAccess_…/jeremy is not authorized to
> perform: iam:PassRole on resource: arn:aws:iam::913756569129:role/agentforge-spike-agentcore-execution
> ```
>
> The execution role itself exists (the operator created it out of band); passing it is the block, so creating more roles does not help. ECR, DynamoDB and S3 are all reachable under the same profile — AgentCore alone is gated.
>
> **Remediation, operator's choice:** add `iam:PassRole` on that role ARN, conditioned on `iam:PassedToService: bedrock-agentcore.amazonaws.com`, to the PowerUser permission set; or run the AgentCore spikes from the admin identity that created the role. `spikes/agentcore/` holds everything else ready to go.


`/ping` is a lifecycle signal, not admission control, so a container should receive a start, a poll or a cancel whatever it last reported (`ARCHITECTURE.md` §4). That is inference from the contract's silence, and the whole await path rests on it.

**Spike (AgentCore):** hold a long task while reporting `HealthyBusy`; send a second `SendMessage`, a `GetTask` and a `CancelTask` to the same session; record delivery, latency and what the container sees. Confirm two tasks can run in one container, that no second container appears for one session id — including in the provisioning window that returns 409 — and what the startup window for the first `Healthy` response actually is.

## §C — Cancellation on the platform *(the local half SETTLED 2026-09-22; the platform half BLOCKED with §B)*

The mechanism is decided: `CancelTask` reaches the gateway, which stops the task gracefully and then kills its process group, with `StopRuntimeSession` as the blunt fallback (`ARCHITECTURE.md` §4).

**Settled locally** — [`research/task-process-and-cost.md`](research/task-process-and-cost.md), `spikes/task-process/`:

- The protocol runs over a **dedicated bidirectional socketpair on fd 3** (`"socket-fd"` at stdio index 3, `net.connect({ fd })` at the parent). The task wrote a decoy protocol response to stdout claiming a different outcome and the executor was unaffected, so the separation is real rather than nominal.
- `cancel` over the protocol settles a run gracefully in **5 ms**.
- A task that **ignores `SIGTERM`** — a no-op handler replaces the default disposition — is killed at **511 ms** against a 500 ms grace, `signal = SIGKILL`.
- **`SIGKILL` of the process group takes a grandchild the task started**; the negative control, killing the process alone, left it running. `detached: true` (`setsid`) plus `kill(-pid)` is what makes this true.
- **A cancel arriving before the task process exists** is caught by a token set before the executor's first `await`.

**Not settled, and not attemptable on 2026-09-22** — blocked with §B on `iam:PassRole`: whether the container receives `SIGTERM` under `StopRuntimeSession` and how long before the kill; whether telemetry flushes and an outcome is recorded inside the grace period; whether a Claude session left mid-turn resumes cleanly; and the third of the three cases below, which is inherently a platform question.

Three cases the implementation must cover whichever way the spike goes: a cancel arriving **before the task process exists** (settled above); a cancel from a caller that **attached to another caller's task**; and a cancel reaching a **freshly provisioned container**, whose A2A SDK would otherwise mark the task cancelled without consulting the executor that owns it.

## §D — Image determinism and deploy granularity *(the layering question SETTLED 2026-09-22; the rest OPEN)*

**Settled: [ADR 0008](../adr/0008-code-ships-in-the-image.md) holds.** Measured over a real three-level tree — one AgentForge base, one agentic base, three agents — on the **manifest digests a registry serves**. Findings in [`research/image-determinism.md`](research/image-determinism.md); spike in `spikes/images/`.

- An unchanged rebuild is **byte-identical**: all five digests unmoved across two full rebuilds.
- A change to one agent **does not spread**: `agent-a` moved; `agent-b`, `agent-c` and the agentic base were identical.
- A change to the agentic base **moves all three agents and nothing below**: the AgentForge base image was identical.

So `UpdateAgentRuntime` can be driven by digest comparison, and an unaffected agent is never given a new version.

**What determinism requires, isolated by experiment:** `SOURCE_DATE_EPOCH` **and** `rewrite-timestamp=true`. With both, identical; with `SOURCE_DATE_EPOCH` alone, **moved**. The epoch normalises the image config's `created` field and leaves file mtimes in the layers, so **a pipeline setting only `SOURCE_DATE_EPOCH` looks reproducible and is not**. Also required: `--provenance=false`, every parent pinned by digest, and no unpinned package installs.

**Three obstacles the deploy path must account for**, none exotic and none obvious: the `docker` driver **cannot export OCI at all**; the `docker` *exporter* does not rewrite layer timestamps, so `docker image inspect --format '{{.Id}}'` **moves on every build** and is useless as a change signal (use buildx's `--metadata-file` `containerimage.digest`); and a `docker-container` builder **cannot see daemon images**, so a multi-level `FROM` chain needs a registry between levels — which is the real shape anyway.

**Still open:**

- **Bun's bundler determinism.** The fixtures copy plain files; nothing was bundled. Whether `bun build` emits byte-identical output — module ordering, chunk hashing, embedded paths — is the likelier source of non-determinism in a real agent image than anything Docker does.
- Comparing digests before `UpdateAgentRuntime`, so an unchanged agent is never given a new version — the digest is available and stable; the deploy path is not written.
- How the task protocol's version is negotiated, and how long an executor supports an older task process, now that the base image and a consumer's harness move independently.
- Whether the agent card is generated as a build step from the image's own registry of procedures.
- Where `agentforge/a2a-claude` is published, how a consumer pins it, and whether the constructs assert a compatible package-and-image pairing at deploy rather than at first task.

## §E — What the kernel still needs *(SETTLED 2026-09-22)*

Settled by spike against `@anthropic-ai/claude-agent-sdk@0.3.278` — findings, evidence and method in [`research/kernel-settlement.md`](research/kernel-settlement.md); the spikes are in `spikes/kernel-settlement/`. The rules the kernel must follow move to `ARCHITECTURE.md` §7.

- **A final submission survives foreground dispatch**, in every shape tried — subagents and long tool storms alike. The foreground rule buys nothing on its own.
- **D9's failure changed shape rather than going away.** A resumed turn no longer cancels its tool calls; on an **open-input** session a completing background task starts a new turn and publishes a **second, contradictory result**. Closed input yields exactly one result and kills the background task.
- **The carrier is a real tool named `StructuredOutput`**, advertised in `init.tools`, so a matcher can name it and its existence is assertable at startup. A wrong matcher fires zero times, silently.
- **An in-turn rejection adds what the schema cannot express**, and an `updatedInput` repair is 4× cheaper than a denial. But a denial contradicting the contract is refused by the model as an injected instruction, and a denial loop ends in `subtype: success` with **no output at all**.
- **Every option tried binds; an unknown key is silently ignored**, so D5's promise is AgentForge's to keep. `maxTurns` and `maxBudgetUsd` bind by **throwing**, not by a result message.

**Still open, narrowly:** whether the base image sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. It removes `run_in_background` from the Bash tool's schema outright — a real kill switch — but no procedure could then opt in, and closed input already kills background tasks at the result. Decided when a procedure asks for background work.

## §F — The sync declaration and the project key *(OPEN)*

Decided: state persists through APIs ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). Transcripts mirror through a `SessionStore`; the config directory is image content; working directories sync to an object store under **a strategy the consumer declares, per agent and overridable per procedure**. AgentForge guarantees the flush-and-verify barrier, the process-group lifetime, and that a sync failure is an outcome.

**The declaration is settled in shape**: the agentic project declares it whole, with every field required so nothing is implicit, and a procedure overrides the fields it differs on. What remains is the fields themselves:

- Direction — up only, down only, or both — and, if both, what wins a conflict, which is the one genuinely hard case and may be reason enough not to offer it
- Delete propagation, as an explicit choice rather than a default
- Cadence — once at the close, on an interval, or on change — and the quiescence threshold that keeps a file mid-write out of a continuous pass
- Exclusions: whether AgentForge ships a starting list (`.git`, `node_modules`, editor scratch) that a project must still accept explicitly, or writes its own from nothing
- How a partial override reads at the call site, and whether an override may relax something the project tightened

**The implementation.** Leading candidate is [`s7cmd`](https://github.com/nidor1998/s7cmd): a single static Rust binary with ARM64 Linux builds, Apache-2.0, bundling the `s3sync` engine — local-to-S3, S3-to-local and S3-to-S3, include and exclude patterns, filtering by `LastModifiedDate` and size, checksum verification, configurable concurrency and a dry run. The `LastModifiedDate` filter is also the quiescence heuristic: sync only what has been still for longer than a threshold, so a file mid-write is left for the next pass. Against it: a personal project whose dependencies are updated best-effort, shipped in our base image and running with credentials — so pin it by digest, and keep an AWS-SDK walk as the fallback if that risk stops being acceptable.

**The project key is decided** (`ARCHITECTURE.md` §6): derived from the agent and its working directory, carried in `CLAUDE_CODE_PROJECT_DIR_NAME`, sanitized to the 1–64 character alphabet that variable allows, and asserted after the run because an invalid name fails silently. What remains is the derivation's details — how the working directory reduces to a segment, and how truncation stays stable when a lane name changes length.

**The remaining edges**, whatever is declared: when a file is quiescent enough to upload so a half-written file is not published; how writes are coalesced so a tool loop is not a request storm; and what a caller sees when a run is lost mid-sync, which is partial artifacts already visible — consistent with `LOST` meaning side effects may have happened, but worth writing down rather than discovering.

## §G — Health and per-task cost *(SETTLED 2026-09-22)*

Measured; [ADR 0004](../adr/0004-a-process-per-task.md) confirmed. Findings in [`research/task-process-and-cost.md`](research/task-process-and-cost.md), spike in `spikes/task-process/`.

- **`/ping` is untouched by running tasks.** Four tasks, two of them saturating a core, moved p95 not at all: 1.32 ms idle against 0.18 ms busy. D31 holds by construction, because the tasks are separate processes.
- **A process per task costs 65 ms** ready-to-serve with the Agent SDK imported (15 ms without) — **0.054 %** of a 120-second run.
- **Per-task fixed memory is tens of megabytes**, ≈ 61 MB RSS, so the admission limit will be governed by what an agent run costs rather than by the process-per-task decision. The limit itself is **not** derived from this number: the fixture does not spawn the Claude Code CLI a real task spawns, and a limit set from a harness floor would err in the unsafe direction. Measured properly on AgentCore.

## §H — Container identity *(OPEN)*

The key, its two edges and its retention are settled: seven days, with the key scoped to the caller's run so nothing re-sends it afterwards ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md), `ARCHITECTURE.md` §4). What remains:

- **Container instance identity** — how a container names itself in the record, so a later one in the same runtime session recognizes a dead one's task as lost without waiting for the lease.

## §I — How the server is assembled *(DECIDED 2026-09-22 — the AgentCore half remains)*

**Decided:** assemble directly from `@a2a-js/sdk` and Express, porting `serveA2A`'s AgentCore-contract mechanics rather than depending on it — [ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), status `proposed`. Findings in [`research/a2a-server-assembly.md`](research/a2a-server-assembly.md); the spike is `spikes/server-assembly/i1-gateway-wrap.ts`. **The first slice is unblocked.**

`serveA2A` was excluded on two independent grounds: its options take an **executor and no request handler**, and `buildA2AApp` constructs `DefaultRequestHandler` itself — so there is no seam for a gateway, which does not change when it publishes; and it is not in `bedrock-agentcore@0.4.4`, the latest published version. The gateway shape itself was confirmed in full: `returnImmediately` resolved in 8 ms against a 6 000 ms run on a synchronously published `submitted`, and blocked for exactly the deferral when the publish was withheld; a duplicate idempotency key returned the running task with the executor started once; a uuid7 `contextId` returned verbatim; cancel reached the executor; admission refused rather than queued; and a client built from a known card signed through `JsonRpcTransportFactory`'s `fetchImpl` without fetching a card.

Two constraints found along the way, both recorded in the research note: **`@a2a-js/sdk@1.2.0` is protobuf-typed**, so a part written the way the specification documents it serializes to an empty part with no error; and **an absent `A2A-Version` header means protocol 0.3**, so anything that drops it downgrades the request.

**Still open — needs AgentCore:**

- Whether `InvokeAgentRuntime` forwards `A2A-Version`. A silent downgrade presents as a blanket `VERSION_NOT_SUPPORTED`, so this is checked first.
- Whether a client-supplied `contextId` (uuid7) survives the pass-through and returns on every task. It survives the SDK; the pass-through is untested.
- AgentCore's real 409 and 424 as errors the client can act on, and retrying the retryable 409 with backoff, which A2A clients do not do on their own.
- Whether `GetAgentCard` validates what it returns.

## §K — The plugin and construct surface *(OPEN)*

Delivered as an Nx plugin with generators, constructs and a deploy path ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Designed once the first real agent exists to show what they should write. Open:

- Which generators exist and what each writes: an agentic project, an agentic base image, an agent over it, a procedure, a caller's wiring
- **The sync generator** — what it keeps current as AgentForge changes (wiring, construct props, the caller's client, image pins), how it reports a change it cannot make automatically, and how much of `@aws/nx-plugin`'s own sync machinery is reused
- What each construct covers, what a consumer supplies, and how several agents share or separate stores, buckets and the registry
- The AppConfig runtime configuration an agent's ARN is published into, following `@aws/nx-plugin` ([research](research/aws-nx-plugin.md)): its schema, what the identity triple keys, caching and refresh, and what a long-lived caller such as a Temporal worker pays to read it (D31, D32)
- Whether the generated client factory mirrors its `.local()` / `.withIamAuth()` shape

## §L — Where the consumers still pull apart *(OPEN — operator)*

Most apparent divergence dissolved in the distillation ([CONSUMERS.md](CONSUMERS.md)). What remains:

- **What a session sees at its start (D7).** StrategyFoundry composes everything; TrendBot expects per-agent and shared capability scopes to be present. Both hold if the answer is configuration — which capability directories an image and its mounts contain — but that configuration is not designed.
- **Holding a failed attempt (D21).** TrendBot holds one for operator review, today in its own activity code. Whether AgentForge does anything beyond making the failure observable is TrendBot's to say.
- **Secrets (D29, §O).** Secret storage is the consumer's, but "each deployment reads only the secrets it declares" and "no credential in anything the harness emits" are partly ours.
- **Procedures that invoke no agent (T4).** Raised by the §N spike on 2026-09-22. TrendBot **T4** requires them — vault reads, corpus scans, snapshot and publish composers, measurement runs of up to an hour — sharing a directive's contract, invocation, failure and side-effect phases, minus the agent run. `ARCHITECTURE.md` §11 excludes them: "AgentForge runs agents; a consumer's plain work belongs in the consumer". **T4's stated reason is co-location** — the work needs the container's working copy — which "put it in the consumer" does not answer, so this is not a misreading of the contract. Three shapes: hold the line, and TrendBot duplicates the working-copy sync in its own container; **admit a second procedure kind** with the same machinery minus the run, which is cheap to build but makes §11 false and needs a superseding ADR; or treat it as a procedure with a trivial run, which is dishonest and burns a model call per vault read. Operator's, with TrendBot ([research](research/procedure-authoring.md)).

## §M — Pausing for a human *(OPEN — operator)*

Neither consumer requires it, so nothing is built. It is here because the shape should be decided rather than fall out of whichever case ships first.

**The agent never learns how a human was reached.** The trigger is the SDK's own permission interrupt, which the harness turns into an A2A pause; the caller waits however it likes, and nothing below the client knows a workflow and a signal were involved.

- **M1 — Block in place.** The interrupt blocks while `/ping` reports `HealthyBusy`. Keeps the turn's context and the pending tool call; costs a held process and session, and cannot outlive the 8-hour job cap.
- **M2 — Park as a task state.** The task moves to `input-required` carrying the request and the schema of its answer; the run ends at a step boundary; the answer arrives on a later send against the same task. Unbounded and cheap; loses the in-flight tool call, and resumes through session resume rather than mid-turn.
- **M3 — Both**, per pause point.

Four rules hold whichever is chosen ([reference](research/harness-references.md)): the request carries the **schema of the answer**, validated at the boundary; a malformed answer is rejected **without consuming the pause**; pending pauses appear in the task's own state as well as on the stream; and the surface that resolves a pause is **not on the agent card** beside ordinary procedure calls.

## §N — How a procedure is written *(DECIDED 2026-09-22)*

**Decided: the object literal (N1)** — [ADR 0013](../adr/0013-a-procedure-is-an-object-literal.md), status `proposed`. Settled by writing a baseline inferred from both consumers in all three styles and running the compiler over deliberately-wrong variants, not by argument. Findings in [`research/procedure-authoring.md`](research/procedure-authoring.md); spike in `spikes/procedure-authoring/`.

- **On safety the three are equal.** Six real composition mistakes, written in all three styles and fed to `tsc --strict`: **all three caught all six**. The builder's one claimed advantage — `.build()` reachable only on a complete builder — is matched by the literal's own parameter type, without the machinery.
- **On inspectability the literal wins**: the declaration *is* the resolved object. The class needs `new Draft().resolve()` — instantiation and a method call — so the card generator would have to construct objects to read procedures.
- **The class has an unguarded hazard**, which is what rejects it: `override guardrails() { return []; }` **silently drops every house guardrail and `tsc` accepts it**. In the literal and the builder that mistake is not expressible.
- **N2 is not foreclosed.** Both resolve to the same object, so a builder can be added later as sugar if verbosity becomes a real problem. It is rejected as unearned, not as wrong.

**The gate is clean.** Standard TypeScript 5 decorators run on Bun 1.4.0 and **preserve inference through the decorated member** (proved with `@ts-expect-error`). `Symbol.metadata` is undefined and needs the one-line polyfill `Symbol.metadata ??= Symbol('Symbol.metadata')`. So decorators were available on merit and were not chosen: registration at module load is all they buy, and an exported literal is already discoverable through the same import graph.

**Raised, not resolved — belongs in §L.** TrendBot **T4** requires procedures that invoke no agent; `ARCHITECTURE.md` §11 excludes them. T4's reason is **co-location** — the work needs the container's working copy — which "put it in the consumer" does not answer. Three shapes, the operator's call with TrendBot: hold the line and make TrendBot duplicate the sync machinery; admit a second procedure kind with the same contract, invocation, failure and phase machinery minus the run, which makes §11 false and needs a superseding decision; or pretend it is a procedure with a trivial run, which would burn a model call per vault read.

## §O — Credentials in the container *(OPEN — operator)*

The Agent SDK reads the subscription token from the environment and offers no provider interface, so that token stays there. The question is everything else: the provider API keys a procedure's tools need, which arrive from a secret store through AgentCore Identity and would otherwise sit in the same environment the agent's own shell can read.

- **Decided: the environment now, a proxy later.** The subscription token and a procedure's provider keys reach the container from a secret store through AgentCore Identity and live in the environment, where the agent's own shell can read them. That exposure is recorded rather than mitigated in the first slice; the base image keeps room for a broker in the shape of something like Infisical's agent-vault. Open is what the broker would look like when it arrives, and what the first slice must avoid doing to keep it cheap.
- How expiry surfaces as `CREDENTIAL_EXPIRED` rather than as a transient provider failure
- Rotation, and how a new key reaches a task that started before it changed
- What a compromised or prompt-injected procedure can reach inside the microVM, and what is therefore not defensible by scrubbing an environment

---

## Tabled

Not open questions — deliberately not being worked until something asks for them.

- **Mounted filesystems, and the VPC they require.** Both consumers are served by the sync mechanism, so AgentForge supports no mount today. A consumer that needs live shared POSIX configures one in its own CDK; making it first-class means the whole VPC surface — NAT, endpoints, allow-listed availability zones, mount-target alignment, paired 2049 rules, ENI lifecycle — and waits for an explicit requirement.

---

## Spike plan

**Every spike lands as an integration test** (`ARCHITECTURE.md` §9), so its answer is re-checked as the platform moves rather than recorded once and trusted. Local spikes need only Bun, Docker and the SDK. AgentCore spikes run against a throwaway runtime, never a deployment, and stub the model call so they stay cheap and deterministic.

| Spike | Answers | Needs |
|---|---|---|
| A2A server assembly, the wrapping gateway, client signing | §I | Local |
| Kernel settlement and structured output | §E | Local — **done**, `spikes/kernel-settlement/` |
| Task-process protocol, cancellation, group kill | §C, §G | Local — **done**, `spikes/task-process/` |
| Procedure authoring against an inferred baseline | §N | Local — **done**, `spikes/procedure-authoring/` |
| Credential provisioning and expiry | §O | Local |
| Deterministic image builds and skipped deploys | §D | Local — **done**, `spikes/images/` |
| Busy-container reachability and concurrency | §B | AgentCore |
| Cancellation on the platform | §C | AgentCore |
| Task store lease and visibility | §A | AgentCore |
| Session resume across containers, and workspace sync | §F | Local, then AgentCore |
