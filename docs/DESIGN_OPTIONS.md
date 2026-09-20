# Design Options

The drafting log. A question is worked here until it is decided; the outcome then moves to the document that owns it — [`ARCHITECTURE.md`](ARCHITECTURE.md) for structure, [`GLOSSARY.md`](GLOSSARY.md) for terms — and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. Only what is undecided stays here.

Sections are marked **[OPEN §x]** at their points of use. Do not build against one, and do not resolve one silently.

**Settle platform behavior by testing it.** Where a question turns on what AgentCore, the A2A SDK, S3 Files, or the Agent SDK actually does, a spike against the real thing answers it, and the result is recorded in [`research/`](research/) before the decision leaves this file.

---

## §A — Where task state lives *(OPEN)*

The store must outlive the microVM, serve the A2A task store, index tasks by idempotency key, and hold a lease ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)).

**Its interface is not open and is settled in the first slice**, because the local filesystem store and the cloud store must implement the same thing: a conditional insert for the idempotency index, and a fenced write that rejects a stale lease generation. A2A's `TaskStore.save` overwrites unconditionally, so this is ours to add. What remains open is only the backing:

- **DynamoDB for state, S3 for payloads.** Conditional writes give attach-or-start atomically; lease renewal is a cheap update; payloads escape the 400 KB item limit. Leaning.
- **S3 alone**, through the API or a Files mount. One service; read-after-write and listing semantics to verify for the lease.
- **The consumer's database.** Rejected unless a consumer requires it: it would put layer 1's state behind a consumer's schema.

**Spike:** write and renew a lease from inside a microVM; read it from outside; measure visibility latency and the cost of renewal at the interval loss detection needs.

## §B — Concurrency and reachability of a busy session *(OPEN)*

A runtime session is an isolation boundary; how many tasks run inside one is AgentForge's to allow and the consumer's to use (`ARCHITECTURE.md` §2). What the platform does is not documented: whether an invocation arriving while `/ping` reports `HealthyBusy` is delivered, queued, or refused, and whether concurrent invocations to one session are delivered in parallel.

Everything a caller does after `SendMessage` depends on it — `GetTask`, `CancelTask`, and attaching a retry all reach a busy container.

**Spike:** a runtime holding a long task; send a second `SendMessage`, a `GetTask`, and a `CancelTask` to the same session; record delivery, latency, and what the container sees. Confirm that two tasks can run in one container at once, and that no second container appears for one session id, including during the provisioning window that returns 409.

## §C — Cancellation *(OPEN)*

- **C1 — `CancelTask`**, which the TaskExecutor turns into a graceful stop and then a process-group kill. Keeps the container and its other tasks alive. Depends on §B.
- **C2 — `StopRuntimeSession`**, which terminates the microVM. Blunt: it takes every other task in the session with it, and whether the container gets a graceful signal first is undocumented.

Three cases the mechanism must cover whichever is chosen: a cancel arriving **before the task process exists**; a cancel from a caller that **attached to another caller's task**, which ends work nobody else asked to stop; and a cancel reaching a **freshly provisioned container** whose A2A SDK would otherwise mark the task cancelled without consulting the executor that owns it.

Leaning C1, with C2 as the fallback when the container cannot be reached. **Spike:** cancel mid-run both ways; measure time to termination; whether the container receives `SIGTERM` under C2 and how long before the kill; whether telemetry flushes and an outcome is recorded inside the grace period; whether a Claude session left mid-turn resumes cleanly. Locally `docker stop` stands in for C2.

## §D — The bundle mount *(OPEN)*

A published bundle must be visible to the next task process without an image rebuild ([ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)).

**Spike:** within AgentCore Runtime's [filesystem limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html#_limits), mount a bundle; measure module-load time for a task against a baked bundle; publish a new bundle and confirm the next task runs it while a running task is unaffected; confirm a stale contract hash is refused.

## §E — Kernel settlement on the current SDK *(OPEN)*

What the first AgentForge learned about settling a run may not hold. To establish locally, against the current SDK:

- Structured output with dispatched work in the foreground — does the final submission survive?
- With background work enabled, does a resumed turn still cancel its tool calls, including the final submission?
- Which schema conversions the structured-output path still needs — root type, `$defs`, `format`, `const`, `enum` — rather than inherited workarounds
- Rejecting a non-conforming submission from a `PreToolUse` hook: does the agent correct in-turn, and how does the SDK's own retry cap interact?
- Does every option set — `maxTurns` among them — actually reach and bind the run?

## §F — How a Claude session persists for resume *(OPEN)*

A session must be resumable in another container (H14), and each runtime session's state must be private and survive its container (T31).

- **F1 — The SDK's `SessionStore` adapter.** *Leaning, on the evidence below.* Transcripts mirror to S3 or a database; resume loads from the store into a temporary config directory. Keyed by the working directory, so resume needs a matching one. Mirror writes are best-effort with a `mirror_error` message on failure, and a run resumed from the store leaves no local copy.
- **F2 — A persistent mount for `~/.claude` and the working directory.** What StrategyFoundry assumed; no SDK dependency, but state is tied to what is mounted where.

F2 is worse than it looks: a mount path must be `/mnt/<one level>`, so `CLAUDE_CONFIG_DIR` moves there and takes `.credentials.json` with it onto shared storage; a shared S3 Files or EFS mount is visible to every session using that access point; and session storage — the per-session alternative — is Preview, capped at 1 GB, and **wiped on a runtime version update**, so a deploy would destroy every transcript and working copy.

**Spike:** both paths, resuming a session in a second container, including a subagent transcript, and a forced mirror failure.

## §G — Health and per-task cost *(OPEN)*

Measure under a real run: `/ping` latency with tasks in child processes, several at once; the start cost of a process per task — module load from the mount plus SDK startup — against a typical run. Confirms or overturns [ADR 0004](../adr/0004-a-process-per-task.md) with numbers.

## §H — Idempotency record details *(OPEN)*

The caller supplies the key and the two edges are settled ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md), `ARCHITECTURE.md` §4). Open:

- **Retention** — its default, and whether a consumer sets it. It must exceed the longest retry horizon a consumer configures, and TrendBot sets timeouts where it registers activities (T2), so AgentForge cannot read that horizon from a declaration.
- **Container instance identity** — how a container names itself in the record so a later one recognizes a dead one's task as lost.
- **A caller-minted task id** and **`contextId` as the key** were both considered and rejected ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)): the first moves a multi-probe look-back onto the caller, where each probe is an AgentCore invocation; the second collides with the Claude session, which is what a context naturally names.
- Powertools idempotency was considered and kept as a reference only: outside Lambda an in-progress record stays locked until expiry, there is no lease renewal, and it caches the wrapped function's return value rather than an outcome ([research](research/a2a.md)).

## §I — How the server is assembled *(OPEN — blocks the first slice)*

This is not a detail to verify later: it decides the shape of the server and the store, and the first local slice cannot be written around it.

- **The request handler.** Idempotency, admission and the contract-hash check must run before a task id is minted, which the SDK's `DefaultRequestHandler` does not allow. The shape is a handler implementing the public `A2ARequestHandler` interface and delegating to the SDK's once it has decided the request is a new task. Confirm that wrapping works, and that a `submitted` event published synchronously makes `returnImmediately` resolve.
- Whether to build on the AgentCore TypeScript SDK's `serveA2A` — which serves the card, `/ping` and busy tracking, but was merged four days before this was written and is not in the published reference — or to assemble the same from `@a2a-js/sdk` and an HTTP server directly
- `returnImmediately`: the specification says a send MUST return once the task is created; the SDK returns after the *first task event* ([research](research/a2a.md)). Open is whether that is soon enough, and whether the executor must publish a `submitted` event synchronously to make it so
- Protocol version: AgentCore's documentation shows 0.3.0 and `message/send`; the SDK targets 1.0 with a 0.3 compatibility layer
- Error handling: AgentCore returns real HTTP statuses (409, 424) with a JSON-RPC error body where A2A expects 200, and its retryable 409 is not retried by A2A clients
- Authentication: whether the A2A client can send SigV4-signed requests under the caller's least-privilege role (T43), or whether the call goes through `InvokeAgentRuntimeCommand` carrying the JSON-RPC payload
- Identifiers: the SDK mints task and context ids with uuid4 and exposes no hook, but uses a client-supplied value when one is present. The client therefore always supplies `contextId` (uuid7), and treats the task id as opaque
- Whether a client-supplied `contextId` survives AgentCore's pass-through unchanged and comes back on every task
- The client: `JsonRpcTransport` takes a `fetchImpl`, so SigV4 signing and the session header are straightforward, but the card resolver cannot reach a card served through `InvokeAgentRuntime` — the client is constructed with an explicit endpoint and a known card
- Whether `GetAgentCard` validates the card it returns, since AgentCore's examples show protocol 0.3.0 while the SDK emits 1.0

## §O — Credentials in the container *(OPEN)*

The operator's subscription token is long-lived and subscription-wide; the container needs it, the agent's own shell can read anything in its process environment, and an expired one must fail loudly rather than as a generic error (T35, T44).

- How the token reaches the SDK without sitting in the task process's environment — a credential helper the SDK re-runs is the leading shape
- How expiry surfaces as `credential_expired` rather than being classified as a transient provider failure
- What a compromised or prompt-injected procedure can reach from inside the microVM, and what is therefore not defensible by scrubbing an environment
- Rotation, and whether a runtime can hold a credential scoped to itself

## §J — Procedures without an agent *(OPEN)*

TrendBot requires them (T4): working-copy reads, corpus scans, composers, and measurement runs of up to an hour, in the agent container because it owns that working copy, sharing a procedure's contract, invocation, failure and phases minus the agent run. The mechanical run kind is the shape (`ARCHITECTURE.md` §3); open is how much of the Claude kind's machinery it reuses, and the operator's constraint that the agent path gives up nothing to it. TrendBot may instead move these to its own API layer, which would be a revision to T4.

## §K — The plugin and infrastructure surface *(OPEN)*

AgentForge is delivered as an Nx plugin with constructs and a publish command ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md), [ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)). Open:

- Which generators exist, and what each writes: an agents project with its image, an agent nested in one, a procedure, a caller's client wiring
- What each construct covers, what the consumer must supply, and how several agents share or separate stores, buckets and the image registry
- Build granularity for nested agents: which targets are per agent, and what a shared image change rebuilds
- How much of `@aws/nx-plugin` is reused directly rather than mirrored — its `ts#agent` generator is built for Strands, but its project, registry and construct conventions are not
- Whether the generated client factory mirrors its `.local()` / `.withIamAuth()` shape

## §L — Where the consumers still pull apart *(OPEN)*

Most of what looked like divergence dissolved in the distillation ([CONSUMERS.md](CONSUMERS.md)): the requirements are now stated as behavior, and the mechanisms each consumer had in mind are listed there as not carried. What remains genuinely open:

- **What a session can see at its start (D7).** StrategyFoundry composes everything; TrendBot expects per-agent and shared capability scopes to be present. Both hold if the answer is configuration — which capability directories an agent's image and mounts contain — but the shape of that configuration is not designed.
- **Holding a failed attempt (D21).** TrendBot holds one for operator review; today that lives in its activity code. Whether AgentForge needs to do anything beyond making the failure observable is TrendBot's to say when it adopts.
- **Secrets (D29, §O).** Secret storage is the consumer's, but "each deployment reads only the secrets it declares" and "no credential in anything the harness emits" are partly ours.
- **Procedures without an agent (§J).** In or out depending on whether TrendBot moves them to its own API layer.

## §M — Pausing for a human *(OPEN)*

Neither consumer requires human-in-the-loop today — TrendBot's T22 is an operator hold on a *failed* attempt, which is adjacent but not this — so nothing is built. It is recorded because the shape must be decided rather than fall out of whichever case ships first, and because a pause is the one capability a durable-workflow harness gets free and we do not ([research](research/temporal-agent-harness.md)).

**The agent never learns how a human was reached.** The trigger is the SDK's own permission interrupt — its permission callback, or a hook that asks — which the harness turns into an A2A pause. The caller waits however it likes; a Temporal workflow waiting on a signal is one way, and nothing below the client knows that is what happened.

The constraint: a task is an OS process, and AgentCore caps an asynchronous job at 8 hours, which is not adjustable. The idle timeout and maximum session lifetime are configurable, so they bound a pause only as they are configured — but a pause outliving the job cap cannot be held in a live process at all.

- **M1 — Block in place.** The permission interrupt blocks while `/ping` reports `HealthyBusy`. Closest to asking mid-turn, keeps the turn's context and the pending tool call, bounded by the session lifetime. Costs a held process and a held Claude session for the length of a human's attention.
- **M2 — Park as a task state.** The task moves to `input-required` or `auth-required` carrying the request and the schema of the expected answer; the run ends at a phase boundary; the answer arrives on a later `message/send` against the same task, which A2A allows because those states are not terminal. Unbounded in time and cheap while waiting; it loses the in-flight tool call, and the procedure resumes through the SDK's own session resume rather than mid-turn.
- **M3 — Both**, with the procedure declaring which it wants at a pause point.

Whichever is chosen, four rules from the study hold: the request carries the **schema of the answer**, validated at the boundary; a malformed answer is rejected **without consuming the pause**, so it can be resubmitted; pending pauses appear both on the event stream and in the task's own state, so a caller attaching late sees what is blocked; and the surface that resolves a pause is **not advertised on the agent card** beside ordinary procedure calls, so a calling agent cannot answer a gate meant for a human.

## §N — How a procedure is written *(OPEN)*

The contribution rule and its merge check (`ARCHITECTURE.md` §3) hold whatever the authoring style is, so this is a question of developer ergonomics at the layer a consumer touches most — and ergonomics there is a real requirement, not a preference.

- **N1 — Object literal.** The default reading of the architecture. Inspectable without running it; verbose for a procedure with many phases.
- **N2 — Chained builder.** `defineProcedure(contract).compose(...).configure(...)`; reads well, infers types through the chain, and can make an invalid composition a compile error.
- **N3 — A class whose methods are the steps.** Familiar from other harnesses, good discoverability; the risk is that overriding rather than contributing becomes the habit, which the merge check catches but only at run time.

Independent of the choice, decide by these: whether a wrong composition fails at compile time; whether the resolved configuration is inspectable without executing the declaration; and whether a reviewer can see everything a procedure contributes without following a chain of inheritance.

**Check first, in A0:** whether standard TypeScript 5 decorators on Bun preserve inference through the decorated member, and whether decorator metadata needs a `Symbol.metadata` polyfill under our toolchain. If they are clean, decorator-based registration is available to N2 and N3; if not, it is out on toolchain grounds rather than taste.

**Exit:** settled by writing StrategyFoundry's real M0 procedures in A1, not by argument.

---

## Spike plan

Two questions block the first slice and are decided, not deferred: how the A2A request handler is assembled (§I) and the task store's interface (§A's first paragraph). The local spikes need only Bun, Docker and the SDK; the AgentCore spikes run against a throwaway runtime, never a deployment.

| Spike | Answers | Needs |
|---|---|---|
| Kernel settlement | §E | Local |
| Task-process protocol, cancellation and group kill | §C, §G | Local |
| Session persistence and cross-container resume | §F | Local, then AgentCore |
| A2A server assembly, the wrapping request handler, and client signing | §I | Local |
| Credential provisioning and expiry surfacing | §O | Local |
| Busy-session reachability and concurrency | §B | AgentCore |
| Cancellation on the platform | §C | AgentCore |
| Task store visibility and lease | §A | AgentCore |
| Bundle mount and reload | §D | AgentCore |
