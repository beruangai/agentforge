# Design Options

What is not yet decided. A question is worked here until it is settled; the outcome then moves to [`ARCHITECTURE.md`](ARCHITECTURE.md), or [`GLOSSARY.md`](GLOSSARY.md) for a term, and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. Sections are marked **[OPEN §x]** at their points of use, except §L. Do not build against one, and do not resolve one silently.

**Platform behavior is settled by testing it** — a spike against the real thing, recorded in [`research/`](research/) before the decision leaves this file. Nothing here is settled by reading documentation.

## What is waiting on what

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§I** | How the A2A server is assembled | **Decided 2026-09-22** ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), proposed); AgentCore pass-through still open | The first slice |
| **§A** | Task store details behind the fixed interface | Design in the first slice; one AgentCore spike | The first slice's store |
| **§N** | How a procedure is written | Writing real procedures in A0 | The procedure model |
| ~~§E~~ | ~~What the kernel still needs to settle a run~~ | **Settled 2026-09-22** ([research](research/kernel-settlement.md)) | — |
| **§C** | Cancellation on the platform | Local spike, then AgentCore | Cancel on AgentCore |
| **§O** | What a credential broker looks like when it arrives | Later; the first slice keeps room | Nothing yet |
| **§F** | The sync declaration's fields, and the key's derivation | Design in the first slice | Session resume and artifacts |
| **§B** | Whether a busy container receives invocations | AgentCore spike | The await path on AgentCore |
| **§D** | Image determinism and deploy granularity | Local spike | Deployment |
| **§G** | Health and per-task cost | Local measurement | Confirms ADR 0004 |
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

## §B — Whether a busy container receives invocations *(OPEN)*

`/ping` is a lifecycle signal, not admission control, so a container should receive a start, a poll or a cancel whatever it last reported (`ARCHITECTURE.md` §4). That is inference from the contract's silence, and the whole await path rests on it.

**Spike (AgentCore):** hold a long task while reporting `HealthyBusy`; send a second `SendMessage`, a `GetTask` and a `CancelTask` to the same session; record delivery, latency and what the container sees. Confirm two tasks can run in one container, that no second container appears for one session id — including in the provisioning window that returns 409 — and what the startup window for the first `Healthy` response actually is.

## §C — Cancellation on the platform *(OPEN)*

The mechanism is decided: `CancelTask` reaches the gateway, which stops the task gracefully and then kills its process group, with `StopRuntimeSession` as the blunt fallback (`ARCHITECTURE.md` §4). What is not known is how the platform behaves.

**Spike (local, then AgentCore):** cancel mid-run both ways; measure time to termination; whether the container receives `SIGTERM` under `StopRuntimeSession` and how long before the kill; whether telemetry flushes and an outcome is recorded inside the grace period; whether a Claude session left mid-turn resumes cleanly. `docker stop` stands in locally.

Three cases the implementation must cover whichever way the spike goes: a cancel arriving **before the task process exists**; a cancel from a caller that **attached to another caller's task**; and a cancel reaching a **freshly provisioned container**, whose A2A SDK would otherwise mark the task cancelled without consulting the executor that owns it.

## §D — Image determinism and deploy granularity *(OPEN)*

Layering keeps a change from spreading only if an unaffected agent rebuilds to a byte-identical image and is never updated ([ADR 0008](../adr/0008-code-ships-in-the-image.md)). Open:

- What reproducible builds take on this toolchain — pinned bases, bundler output, file ordering, timestamps — and whether Bun's bundler is deterministic enough unaided
- Comparing digests before `UpdateAgentRuntime`, so an unchanged agent is never given a new version
- How the task protocol's version is negotiated, and how long an executor supports an older task process, now that the base image and a consumer's harness move independently
- Whether the agent card is generated as a build step from the image's own registry of procedures
- Where `agentforge/a2a-claude` is published, how a consumer pins it, and whether the constructs assert a compatible package-and-image pairing at deploy rather than at first task

**Spike (local):** build one agentic base image and three agent images over it; change one agent's procedure; confirm the other two rebuild to identical digests and the deploy path skips them; then change the agentic base image and confirm all three move.

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

## §G — Health and per-task cost *(OPEN)*

Measure under a real run: `/ping` latency with several tasks in child processes; the start cost of a process per task — module load plus SDK startup — against a typical run's duration. Confirms or overturns [ADR 0004](../adr/0004-a-process-per-task.md) with numbers.

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

## §M — Pausing for a human *(OPEN — operator)*

Neither consumer requires it, so nothing is built. It is here because the shape should be decided rather than fall out of whichever case ships first.

**The agent never learns how a human was reached.** The trigger is the SDK's own permission interrupt, which the harness turns into an A2A pause; the caller waits however it likes, and nothing below the client knows a workflow and a signal were involved.

- **M1 — Block in place.** The interrupt blocks while `/ping` reports `HealthyBusy`. Keeps the turn's context and the pending tool call; costs a held process and session, and cannot outlive the 8-hour job cap.
- **M2 — Park as a task state.** The task moves to `input-required` carrying the request and the schema of its answer; the run ends at a step boundary; the answer arrives on a later send against the same task. Unbounded and cheap; loses the in-flight tool call, and resumes through session resume rather than mid-turn.
- **M3 — Both**, per pause point.

Four rules hold whichever is chosen ([reference](research/harness-references.md)): the request carries the **schema of the answer**, validated at the boundary; a malformed answer is rejected **without consuming the pause**; pending pauses appear in the task's own state as well as on the stream; and the surface that resolves a pause is **not on the agent card** beside ordinary procedure calls.

## §N — How a procedure is written *(OPEN)*

A question of ergonomics at the layer a consumer touches most, which is a requirement rather than a preference.

- **N1 — Object literal.** Inspectable without running it; verbose for a procedure with many parts.
- **N2 — Chained builder.** Reads well, infers types through the chain, can make an invalid composition a compile error.
- **N3 — A class whose methods are the steps.** Familiar and discoverable; the risk is that overriding rather than contributing becomes the habit.

Decide by: whether a wrong composition fails at compile time; whether the resolved configuration is inspectable without executing the declaration; whether a reviewer sees everything a procedure contributes without following an inheritance chain.

**Check first:** whether standard TypeScript 5 decorators on Bun preserve inference through the decorated member, and whether decorator metadata needs a `Symbol.metadata` polyfill. If clean, decorator registration is available to N2 and N3; if not, it is out on toolchain grounds rather than taste.

**Exit:** settled by writing a **baseline set of procedures inferred from both consumers** — their contracts, specs and existing code — and authoring each candidate style against it. AgentForge ships before StrategyFoundry's development starts, so waiting for its real procedures would wait forever; and a style settled against one consumer's first attempt would be coupled to it anyway. The baseline is representative, not exhaustive: enough shapes to expose the differences between the styles.

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
| Task-process protocol, cancellation, group kill | §C, §G | Local |
| Procedure authoring against real procedures | §N | Local |
| Credential provisioning and expiry | §O | Local |
| Deterministic image builds and skipped deploys | §D | Local |
| Busy-container reachability and concurrency | §B | AgentCore |
| Cancellation on the platform | §C | AgentCore |
| Task store lease and visibility | §A | AgentCore |
| Session resume across containers, and workspace sync | §F | Local, then AgentCore |
