# Design Options

The drafting log. A question is worked here until it is decided; the outcome then moves to the document that owns it — [`ARCHITECTURE.md`](ARCHITECTURE.md) for structure, [`GLOSSARY.md`](GLOSSARY.md) for terms — and an [ADR](../adr/README.md) records the reasoning where it is worth keeping. Only what is undecided stays here.

Sections are marked **[OPEN §x]** at their points of use. Do not build against one, and do not resolve one silently.

**Settle platform behavior by testing it.** Where a question turns on what AgentCore, the A2A SDK, S3 Files, or the Agent SDK actually does, a spike against the real thing answers it, and the result is recorded in [`research/`](research/) before the decision leaves this file.

---

## §A — Where task state lives *(OPEN)*

The store must outlive the microVM, serve the A2A task store, index tasks by idempotency key, and hold a lease ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)).

- **A1 — DynamoDB for state, S3 for payloads.** Conditional writes give attach-or-start atomically; lease renewal is a cheap update; payloads escape the 400 KB item limit. Leaning.
- **A2 — S3 alone**, through the API or a Files mount. One service; read-after-write and listing semantics to verify for the lease.
- **A3 — The consumer's database.** Rejected unless a consumer requires it: it would put layer 1's state behind a consumer's schema.

**Spike:** write and renew a lease from inside a microVM; read it from outside; measure visibility latency and the cost of renewal at the interval loss detection needs.

## §B — Concurrency and reachability of a busy session *(OPEN)*

A runtime session is an isolation boundary; how many tasks run inside one is AgentForge's to allow and the consumer's to use (`ARCHITECTURE.md` §2). What the platform does is not documented: whether an invocation arriving while `/ping` reports `HealthyBusy` is delivered, queued, or refused, and whether concurrent invocations to one session are delivered in parallel.

Everything a caller does after `SendMessage` depends on it — `GetTask`, `CancelTask`, and attaching a retry all reach a busy container.

**Spike:** a runtime holding a long task; send a second `SendMessage`, a `GetTask`, and a `CancelTask` to the same session; record delivery, latency, and what the container sees. Confirm that two tasks can run in one container at once, and that no second container appears for one session id, including during the provisioning window that returns 409.

## §C — Cancellation *(OPEN)*

- **C1 — `CancelTask`**, which the TaskExecutor turns into a graceful stop and then a process-group kill. Keeps the container and its other tasks alive. Depends on §B.
- **C2 — `StopRuntimeSession`**, which terminates the microVM. Blunt: it takes every other task in the session with it.

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

- **F1 — The SDK's `SessionStore` adapter.** Transcripts mirror to S3 or a database; resume loads from the store into a temporary config directory. Keyed by the working directory, so resume needs a matching one. Mirror writes are best-effort with a `mirror_error` message on failure, and a run resumed from the store leaves no local copy.
- **F2 — A persistent mount for `~/.claude` and the working directory.** What StrategyFoundry assumed; no SDK dependency, but state is tied to what is mounted where.

They differ in what the base image needs, what the CDK constructs provision, and what a lost mirror costs. **Spike:** both paths, resuming a session in a second container, including a subagent transcript, and a forced mirror failure.

## §G — Health and per-task cost *(OPEN)*

Measure under a real run: `/ping` latency with tasks in child processes, several at once; the start cost of a process per task — module load from the mount plus SDK startup — against a typical run. Confirms or overturns [ADR 0004](../adr/0004-a-process-per-task.md) with numbers.

## §H — Idempotency record details *(OPEN)*

The caller supplies the key and the two edges are settled ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md), `ARCHITECTURE.md` §4). Open:

- **Retention** — its default, and whether a consumer sets it. It must exceed the longest retry horizon a consumer configures, and TrendBot sets timeouts where it registers activities (T2), so AgentForge cannot read that horizon from a declaration.
- **Container instance identity** — how a container names itself in the record so a later one recognizes a dead one's task as lost.
- **A caller-minted task id** and **`contextId` as the key** were both considered and rejected ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)): the first moves a multi-probe look-back onto the caller, where each probe is an AgentCore invocation; the second collides with the Claude session, which is what a context naturally names.
- Powertools idempotency was considered and kept as a reference only: outside Lambda an in-progress record stays locked until expiry, there is no lease renewal, and it caches the wrapped function's return value rather than an outcome ([research](research/a2a.md)).

## §I — A2A and AgentCore details to verify *(OPEN)*

- Whether to build the server on the AgentCore TypeScript SDK's `serveA2A`, which wraps an `@a2a-js/sdk` executor and already serves the card, `/ping` and busy tracking, or to assemble the same from `@a2a-js/sdk` directly
- Whether `DefaultRequestHandler` honors `returnImmediately` as the specification describes
- Protocol version: AgentCore's documentation shows 0.3.0 and `message/send`; the SDK targets 1.0 with a 0.3 compatibility layer
- Error handling: AgentCore returns real HTTP statuses (409, 424) with a JSON-RPC error body where A2A expects 200, and its retryable 409 is not retried by A2A clients
- Authentication: whether the A2A client can send SigV4-signed requests under the caller's least-privilege role (T43), or whether the call goes through `InvokeAgentRuntimeCommand` carrying the JSON-RPC payload
- Identifiers: the SDK mints task and context ids with uuid4 and exposes no hook, but uses a client-supplied value when one is present. The client therefore always supplies `contextId` (uuid7), and treats the task id as opaque
- What `DefaultRequestHandler` does with a client-supplied task id naming no stored task — create it, or error. The decision does not rest on this ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)), but a clear answer closes the question
- Whether a client-supplied `contextId` survives AgentCore's pass-through unchanged and comes back on every task

## §J — Procedures without an agent *(OPEN)*

TrendBot requires them (T4): vault reads, corpus scans, composers, and measurement runs of up to an hour, in the agent container because it owns the working copy, sharing a procedure's contract, invocation, failure and phases minus the agent run. The mechanical run kind is the shape (`ARCHITECTURE.md` §3); open is how much of the Claude kind's machinery it reuses, and the operator's constraint that the agent path gives up nothing to it. TrendBot may instead move these to its own API layer, which would be a revision to T4.

## §K — The plugin and infrastructure surface *(OPEN)*

AgentForge is delivered as an Nx plugin with constructs and a publish command ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md), [ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)). Open:

- Which generators exist, and what each writes: an agents project with its image, an agent nested in one, a procedure, a caller's client wiring
- What each construct covers, what the consumer must supply, and how several agents share or separate stores, buckets and the image registry
- Build granularity for nested agents: which targets are per agent, and what a shared image change rebuilds
- How much of `@aws/nx-plugin` is reused directly rather than mirrored — its `ts#agent` generator is built for Strands, but its project, registry and construct conventions are not
- Whether the generated client factory mirrors its `.local()` / `.withIamAuth()` shape

## §L — Where the consumers' contracts pull apart *(OPEN)*

Read from StrategyFoundry's H1–H25 and TrendBot's draft T1–T44 on 2026-09-19. None is a hard conflict; each needs a design serving both through configuration, not a branch.

- **Seed discovery (H6, T5, T6).** StrategyFoundry: nothing discovered at the entry point. TrendBot: capabilities resolve from a per-agent and a shared scope, and its seed invokes a command defined in the container. Both hold if what a session sees at its start is exactly what the consumer configured, including which capability scopes are mounted.
- **Timeouts (H4, T2).** StrategyFoundry declares a run's timeout with the procedure and requires it enforced; TrendBot sets timeout, retry and heartbeat where it registers the activity. The run's time budget and the activity's Temporal timeouts are different things; name both.
- **Failure granularity (H17, T20, T21).** StrategyFoundry needs typed causes so workflows wait on a usage limit; TrendBot maps every error to non-retryable today but distinguishes lost from errored. The outcome taxonomy serves both.
- **Hold for review (T22).** TrendBot holds a failed attempt for the operator. A consumer side effect, or middleware? TrendBot decides whether it asks.
- **Side effects committed twice (T26).** "One invocation's side effects never commit twice" cannot be met by AgentForge alone: a container can die after a side effect and before its outcome is recorded. Under the rule that a consumer owns its side effects and their recovery, the clause is TrendBot's. For the operator's review of TrendBot's draft contract.

## §M — Pausing for a human *(OPEN)*

Neither consumer requires human-in-the-loop today — TrendBot's T22 is an operator hold on a *failed* attempt, which is adjacent but not this — so nothing is built. It is recorded because the shape must be decided rather than fall out of whichever case ships first, and because a pause is the one capability a durable-workflow harness gets free and we do not ([research](research/temporal-agent-harness.md)).

**The agent never learns how a human was reached.** The trigger is the SDK's own permission interrupt — its permission callback, or a hook that asks — which the harness turns into an A2A pause. The caller waits however it likes; a Temporal workflow waiting on a signal is one way, and nothing below the client knows that is what happened.

The constraint: a task is an OS process, and AgentCore caps a session at 8 hours of lifetime and 15 minutes idle. A pause longer than the session lifetime cannot be held in a live process at any price.

- **M1 — Block in place.** The permission interrupt blocks while `/ping` reports `HealthyBusy`. Closest to asking mid-turn, keeps the turn's context and the pending tool call, bounded by the session lifetime. Costs a held process and a held Claude session for the length of a human's attention.
- **M2 — Park as a task state.** The task moves to `input-required` or `auth-required` carrying the request and the schema of the expected answer; the run ends at a phase boundary; the answer arrives on a later `message/send` against the same task, which A2A allows because those states are not terminal. Unbounded in time and cheap while waiting; it loses the in-flight tool call, and the procedure resumes through the SDK's own session resume rather than mid-turn.
- **M3 — Both**, with the procedure declaring which it wants at a pause point.

Whichever is chosen, four rules from the study hold: the request carries the **schema of the answer**, validated at the boundary; a malformed answer is rejected **without consuming the pause**, so it can be resubmitted; pending pauses appear both on the event stream and in the task's own state, so a caller attaching late sees what is blocked; and the surface that resolves a pause is **not advertised on the agent card** beside ordinary procedure calls, so a calling agent cannot answer a gate meant for a human.

## §N — How a procedure is written *(OPEN)*

The contribution rule and its merge check (`ARCHITECTURE.md` §3) hold whatever the authoring style is, so this is a question of developer ergonomics at the layer a consumer touches most — and ergonomics there is a real requirement, not a preference.

- **N1 — Object literal.** What the sketches show. Inspectable without running it; verbose for a procedure with many phases.
- **N2 — Chained builder.** `defineProcedure(contract).compose(...).configure(...)`; reads well, infers types through the chain, and can make an invalid composition a compile error.
- **N3 — A class whose methods are the phases.** Familiar from other harnesses, good discoverability; the risk is that overriding rather than contributing becomes the habit, which the merge check catches but only at run time.

Independent of the choice, decide by these: whether a wrong composition fails at compile time; whether the resolved configuration is inspectable without executing the declaration; and whether a reviewer can see everything a procedure contributes without following a chain of inheritance.

**Check first, in A0:** whether standard TypeScript 5 decorators on Bun preserve inference through the decorated member, and whether decorator metadata needs a `Symbol.metadata` polyfill under our toolchain. If they are clean, decorator-based registration is available to N2 and N3; if not, it is out on toolchain grounds rather than taste.

**Exit:** settled by writing StrategyFoundry's real M0 procedures in A1, not by argument.

---

## Spike plan

The local spikes need only Bun, Docker and the SDK, and come first. The AgentCore spikes run against a throwaway runtime, never a deployment.

| Spike | Answers | Needs |
|---|---|---|
| Kernel settlement | §E | Local |
| Task-process protocol, cancellation and group kill | §C, §G | Local |
| Session persistence and cross-container resume | §F | Local, then AgentCore |
| A2A server assembly and client behavior | §I | Local |
| Busy-session reachability and concurrency | §B | AgentCore |
| Cancellation on the platform | §C | AgentCore |
| Task store visibility and lease | §A | AgentCore |
| Bundle mount and reload | §D | AgentCore |
