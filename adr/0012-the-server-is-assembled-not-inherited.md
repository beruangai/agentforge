---
status: proposed
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# The A2A server is assembled from `@a2a-js/sdk`, not inherited from the AgentCore SDK

## Context and Problem Statement

Idempotency, admission and the contract-hash check must run **before a task id is minted** (`ARCHITECTURE.md` §4). `DefaultRequestHandler` mints the id and creates the event bus before the executor is reached, so those decisions cannot live in an executor — they need a **gateway**: something implementing the public `A2ARequestHandler` interface that delegates to the SDK's only once it has decided a request is a new task.

Where that gateway is installed decides the shape of the container, and the first slice cannot be written around it. The AgentCore TypeScript SDK gained a `serveA2A` helper that already serves the AgentCore contract — the card, `/ping`, JSON-RPC on `POST /`, port 9000 — which would be less to own. Is building on it viable?

## Decision Drivers

* The gateway must be installable, or the architecture does not hold
* The container must serve AgentCore's contract exactly: `0.0.0.0:9000`, or invocations fail with HTTP 424
* `/ping` must report `HealthyBusy` while any task runs, which is AgentForge's own concurrency bookkeeping
* AgentForge depends only on what it can pin, because the base image is what every consumer inherits

## Considered Options

* **Build on the AgentCore SDK's `serveA2A`** — inherit the contract mechanics, own only the executor
* **Assemble directly from `@a2a-js/sdk` and Express**, porting the contract mechanics
* **Wait for `serveA2A` to publish, and decide then**

## Decision Outcome

Chosen option: **assemble directly**, and port `serveA2A`'s AgentCore-contract mechanics into AgentForge's own server rather than depending on it.

The decision rests on two findings from a working spike ([research](../docs/research/a2a-server-assembly.md), `spikes/server-assembly/i1-gateway-wrap.ts`), either of which is sufficient on its own.

**`serveA2A` has no seam for a wrapping request handler.** Read at source, `ServeA2AOptions` is `{ executor, agentCard?, port?, host?, pingHandler?, taskStore?, contextBuilder?, logger? }` — it takes an **executor**, never a request handler — and `buildA2AApp` constructs `new DefaultRequestHandler(agentCard, taskStore, options.executor)` itself before handing it to `jsonRpcHandler`. The gateway must *replace* that handler, and the slot is never offered. This is structural, not a missing feature: it does not resolve when the package publishes.

**It is not published.** `bedrock-agentcore@0.4.4` is the latest published version and contains no `serveA2A` at all — verified by grep across the installed package. The base image every consumer inherits cannot be pinned to an unpublished merge.

**And the gateway shape works.** The spike confirmed all eight of its assertions: a gateway over `DefaultRequestHandler` serves, a synchronously published `submitted` event makes `returnImmediately` resolve in **8 ms against a 6 000 ms run**, a duplicate idempotency key returns the already-running task with the executor started **once**, a client-supplied uuid7 `contextId` returns verbatim, `cancelTask` reaches the executor rather than the SDK's default path, admission beyond the limit is refused rather than queued, and a client built from a known card signs through `JsonRpcTransportFactory`'s `fetchImpl` without fetching a card over HTTP.

The third option — waiting — was rejected because the shape is excluded regardless of publication, so waiting buys nothing and blocks the first slice.

### Consequences

* **Good:** the gateway is expressible, which is the whole point. The server's dependencies are `@a2a-js/sdk` and Express, both pinned, both published.
* **Good:** `/ping` is ours, which it had to be anyway — `serveA2A`'s ping handler defaults to `'Healthy'` and degrades to `'Healthy'` when a custom handler throws, so it does no busy tracking. `HealthyBusy` was never inheritable.
* **Good:** the base image does not carry the AgentCore SDK, which is large and mostly browser and code-interpreter tooling the server never uses.
* **Bad:** AgentForge owns roughly eighty lines of AgentCore-contract mechanics that AWS also maintains, and must track them as the contract moves. They are enumerated in the research note so the tracking is a diff rather than an archaeology: port 9000 from `A2A_PORT` (ignoring `PORT`), bind `0.0.0.0` only inside a container, `/ping` shape, `UserBuilder.noAuthentication` because AgentCore terminates authentication in front of the container, a context builder mirroring the injected headers into `ServerCallContext.state`, and `legacyCompat` enabled on both the card handler and the JSON-RPC handler.
* **Bad:** if AgentCore later changes its contract in a way `serveA2A` absorbs silently, AgentForge finds out from a 424 rather than from a dependency bump. The AgentCore integration tier is what catches that.
* **Neutral:** `serveA2A` remains a useful reference implementation and is read as one. Borrowing its mechanics is deliberate, and the research note records what was borrowed and why.

### Confirmation

The spike is promoted into the server capability's `integ/` (`ARCHITECTURE.md` §9), so every assertion above is re-checked as `@a2a-js/sdk` moves. Two of them are load-bearing enough to name:

* the **negative control** — an executor that defers its first event makes `returnImmediately` block for exactly that long, so the synchronous publish is a correctness requirement with a measurable failure mode
* the **idempotency assertion** counts executor starts, not just task ids, because a gateway that decided too late would still return one id while having started two runs

## More Information

Two facts found along the way constrain the implementation and are recorded in [the research note](../docs/research/a2a-server-assembly.md) rather than here:

* **`@a2a-js/sdk@1.2.0` is protobuf-typed**, so the shapes the A2A specification documents (`{ kind: 'data', data }`, `role: 'user'`, `state: 'submitted'`) are not the shapes the SDK uses — and writing the spec's shape produces an **empty part with no error**.
* **An absent `A2A-Version` header means protocol 0.3**, not "unspecified". Checked against AgentCore on 2026-09-22: the header is **not forwarded by default**, so the negotiated version is 0.3 — but AgentCore takes a per-runtime **request header allowlist** (`requestHeaderConfiguration.requestHeaderAllowlist`), and with `A2A-Version` on it the header arrives and **1.0 negotiates** ([research](../docs/research/agentcore-runtime-observed.md)). So the protocol version is **configurable, not imposed**, and this ADR does not settle which AgentForge runs — `DESIGN_OPTIONS.md` §I carries that choice. What the measurement does settle is that **`legacyCompat` must be enabled regardless**: a missing or misspelt allowlist entry downgrades every call to 0.3 silently rather than failing, so the server must still speak it, and the negotiated version should be asserted rather than assumed.

The AgentCore half of §I — pass-through of `contextId` and headers, real 409 and 424 behaviour, whether `GetAgentCard` validates what it returns — remains open and does not affect this decision.
