# Design Options

What is not yet decided. A question is worked here until it is settled; the outcome then moves to [`ARCHITECTURE.md`](ARCHITECTURE.md), or [`GLOSSARY.md`](GLOSSARY.md) for a term, and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. Sections are marked **[OPEN §x]** at their points of use, except §L. Do not build against one, and do not resolve one silently.

**Platform behavior is settled by testing it** — a spike against the real thing, recorded in [`research/`](research/) before the decision leaves this file. Nothing here is settled by reading documentation.

## What is waiting on what

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§I** | How the A2A server is assembled | Local spike, then a decision | The first slice |
| **§A** | Task store details behind the fixed interface | Design in the first slice; one AgentCore spike | The first slice's store |
| **§N** | How a procedure is written | Writing real procedures in A0 | The procedure model |
| **§E** | What the kernel still needs to settle a run | Local spike | The kernel |
| **§C** | Cancellation on the platform | Local spike, then AgentCore | Cancel on AgentCore |
| **§O** | Credentials in the container | **Operator** — how far to take the proxy | The base image's shape |
| **§F** | How the workspace mount is partitioned | **Operator**, with each consumer | AgentCore deployment |
| **§B** | Whether a busy container receives invocations | AgentCore spike | The await path on AgentCore |
| **§D** | Image determinism and deploy granularity | Local spike | Deployment |
| **§G** | Health and per-task cost | Local measurement | Confirms ADR 0004 |
| **§H** | Retention and container identity | **Operator** — retention window | Idempotency on AgentCore |
| **§K** | The plugin and construct surface | Design, after the first agent exists | A2's tooling |
| **§L** | Where the consumers still pull apart | **Operator**, with each consumer | A3 |
| **§M** | Pausing for a human | **Operator** — whether to support it at all | Nothing yet |

---

## §A — Task store details *(OPEN)*

The interface is fixed and built in the first slice: a conditional insert for the idempotency index, and a fenced write that rejects a stale lease generation, because A2A's `TaskStore.save` overwrites unconditionally. DynamoDB holds the record, with S3 only for a payload too large for an item (`ARCHITECTURE.md` §4). Open:

- The item shape: what the A2A task, the index, the lease and the outcome look like as one record, and what a poll costs to read
- The size at which a payload goes to S3, and how a caller reads one back through A2A without special-casing it
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

**Spike (local):** build one package image and three agent images over it; change one agent's procedure; confirm the other two rebuild to identical digests and the deploy path skips them; then change the package image and confirm all three move.

## §E — What the kernel still needs *(OPEN)*

Structured output is largely answered: the SDK takes a draft-07 schema, validates and re-prompts natively, and fails at startup on an invalid schema ([research](research/claude-agent-sdk.md)). What the first AgentForge learned beyond that may no longer hold.

**Spike (local):** does a final submission survive dispatched work in the foreground; with background work enabled, does a resumed turn still cancel its tool calls; does an in-turn `PreToolUse` rejection still add anything over native re-prompting, and does its matcher name a tool that exists; does every option set — `maxTurns` among them — actually reach and bind the run.

## §F — How the workspace mount is partitioned *(OPEN — operator)*

Decided: state lives on S3 Files, in two mounts — `/mnt/claude-config`, AgentForge's, carrying `CLAUDE_CONFIG_DIR`; and `/mnt/workspace`, the consumer's, holding the working directories procedures run in (`ARCHITECTURE.md` §6).

The workspace is shared on purpose — it is the artifact vault, and procedures are meant to read each other's output — so the open question is how it is partitioned without corruption or leakage:

- Access points and prefixes: one per consumer, per agent, or per procedure, and which of those AgentForge's constructs generate
- The POSIX uid/gid an access point runs as, which must match the container's user
- What prevents two concurrent tasks corrupting one directory, given close-to-open consistency and no cross-session file locking
- Whether `/mnt/claude-config` is partitioned the same way, and what that means for a session resumed by a different agent
- Credentials: `CLAUDE_CONFIG_DIR` holds `.credentials.json`, which on a shared mount is visible to every session using that access point — the reason to keep credentials off disk (§O), not a reason to avoid the mount
- Which VPC preconditions the constructs assert at synth, and which can only be checked at deploy: network mode, availability-zone overlap with the mount targets, security-group rules for TCP 2049, DNS resolution, account boundary, access-point POSIX identity, and the egress the container needs for everything that is not the mount

AgentForge provides the mechanism; each consumer defines its own semantics, so this needs the operator with each consumer rather than a spike.

## §G — Health and per-task cost *(OPEN)*

Measure under a real run: `/ping` latency with several tasks in child processes; the start cost of a process per task — module load plus SDK startup — against a typical run's duration. Confirms or overturns [ADR 0004](../adr/0004-a-process-per-task.md) with numbers.

## §H — Retention and container identity *(OPEN — operator on retention)*

The key and the two edges are settled ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)). Open:

- **Retention** — how long task state is kept for a later start to attach to. It must exceed the longest retry horizon a consumer configures, and a consumer sets that where it registers an activity, so AgentForge cannot read it from a declaration. **Needs a number from the operator.**
- **Container instance identity** — how a container names itself in the record, so a later one recognizes a dead one's task as lost.

## §I — How the server is assembled *(OPEN — blocks the first slice)*

This decides the shape of the server and the store, and the first slice cannot be written around it.

**The decision:** idempotency, admission and the contract-hash check must run before a task id is minted, which the SDK's `DefaultRequestHandler` does not allow. The shape is a gateway implementing the public `A2ARequestHandler` interface and delegating to the SDK's once it has decided a request is a new task. Whether to build on the AgentCore SDK's `serveA2A` — which serves the card and `/ping`, but was merged days before this was written and is not in the published reference — or to assemble the same from `@a2a-js/sdk` and an HTTP server, is part of the same call.

**Spike (local), which the decision waits on:**

- Wrapping `DefaultRequestHandler` works, and a `SUBMITTED` event published synchronously makes `returnImmediately` resolve — the SDK returns after the first event on the task's bus, not on creation
- A client constructed with an explicit endpoint and a known card, signing through `JsonRpcTransport`'s `fetchImpl` with SigV4 and the session header (D32); the card resolver cannot reach a card served through `InvokeAgentRuntime`
- A client-supplied `contextId` (uuid7) survives AgentCore's pass-through and returns on every task
- AgentCore's real HTTP statuses (409, 424) surface as errors the client can act on, and its retryable 409 is retried with backoff, which A2A clients do not do on their own
- Protocol version: AgentCore's examples show 0.3.0 and `message/send` while the SDK emits 1.0 — whether pass-through cares, and whether `GetAgentCard` validates what it returns

## §K — The plugin and construct surface *(OPEN)*

Delivered as an Nx plugin with generators, constructs and a deploy path ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Designed once the first real agent exists to show what they should write. Open:

- Which generators exist and what each writes: an agents project, a package image, an agent over it, a procedure, a caller's wiring
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

**Exit:** settled by writing real StrategyFoundry procedures in A0.

## §O — Credentials in the container *(OPEN — operator)*

The Agent SDK reads the subscription token from the environment and offers no provider interface, so that token stays there. The question is everything else: the provider API keys a procedure's tools need, which arrive from a secret store through AgentCore Identity and would otherwise sit in the same environment the agent's own shell can read.

- **How far to take a credential proxy** at the container level, brokering provider calls so their keys never enter the task process's environment — in the shape of something like Infisical's agent-vault. A later addition rather than a first-slice one, but the first slice should not make it harder. **The operator's call on scope.**
- How expiry surfaces as `CREDENTIAL_EXPIRED` rather than as a transient provider failure
- Rotation, and how a new key reaches a task that started before it changed
- What a compromised or prompt-injected procedure can reach inside the microVM, and what is therefore not defensible by scrubbing an environment

---

## Spike plan

Local spikes need only Bun, Docker and the SDK. AgentCore spikes run against a throwaway runtime, never a deployment.

| Spike | Answers | Needs |
|---|---|---|
| A2A server assembly, the wrapping gateway, client signing | §I | Local |
| Kernel settlement and structured output | §E | Local |
| Task-process protocol, cancellation, group kill | §C, §G | Local |
| Procedure authoring against real procedures | §N | Local |
| Credential provisioning and expiry | §O | Local |
| Deterministic image builds and skipped deploys | §D | Local |
| Busy-container reachability and concurrency | §B | AgentCore |
| Cancellation on the platform | §C | AgentCore |
| Task store lease and visibility | §A | AgentCore |
| Session resume across containers, on the mounts | §F | AgentCore |
