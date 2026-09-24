# A2A server assembly — spike findings

**Read against the real packages on 2026-09-22.** `@a2a-js/sdk@1.2.0`, `bedrock-agentcore@0.4.4` (the latest published), Bun 1.4.0, Express 5. Answers the local half of [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §I. The AgentCore half — pass-through of `contextId` and headers, real 409/424 statuses — is answered separately.

Source: `spikes/server-assembly/i1-gateway-wrap.ts` (retired at A0; git history `d3f08b7`), a complete working gateway over a real HTTP server and a real client. No model spend.

---

## The gateway shape works

All eight assertions confirmed in one run.

| Assertion | Result |
|---|---|
| A gateway implementing `A2ARequestHandler` and delegating to `DefaultRequestHandler` serves | yes — 2 methods intercepted, 10 delegated verbatim |
| A `submitted` event published **synchronously** makes `returnImmediately` resolve | yes — **8 ms** against a 6 000 ms run |
| Without a synchronous publish, `returnImmediately` waits | yes — **3 005 ms**, exactly the deferral |
| A duplicate idempotency key returns the **already running** task | yes — same task id, executor started **once** |
| A client-supplied uuid7 `contextId` returns verbatim on send *and* on poll | yes |
| `cancelTask` reaches the gateway and the executor, not the SDK's default path | yes — task ended `TASK_STATE_CANCELED` |
| Admission beyond the limit is refused, never queued | yes — 2 admitted, 3rd refused |
| A client built from a known card signs through `JsonRpcTransportFactory`'s `fetchImpl` | yes — 9 calls, headers intact, **no card fetched over HTTP** |

**The synchronous publish is load-bearing, not incidental.** The negative control is the point: an executor that awaits anything before publishing its first event makes `returnImmediately` block for exactly that long. `ARCHITECTURE.md` §4's "publishes `submitted` synchronously, before its first `await`" is a correctness requirement with a measurable failure mode, not a style note.

**The gateway is the only place idempotency can live.** With the gateway deciding first, a duplicate key returned the same task id and `executor.started.length === 1`. Anything inside the executor would have had a second task id minted before it ran.

---

## `serveA2A` cannot host a gateway — and is not published anyway

Two independent reasons, either sufficient.

**1. It is not in the published package.** `bedrock-agentcore@0.4.4` is the latest published version (2026-09-11) and contains **no `serveA2A`** — verified by grep across the installed package, not inferred from the docs. The published `bedrock-agentcore/runtime` exports `BedrockAgentCoreApp`, `RuntimeClient` and shell/WebSocket helpers only. `BedrockAgentCoreApp` serves the **HTTP** protocol on port **8080** with a single Zod-schema'd `invocationHandler` — not JSON-RPC, not the agent card, not the A2A contract.

**2. Its shape excludes a wrapping request handler.** Read at source (`aws/bedrock-agentcore-sdk-typescript`, `src/runtime/a2a/app.ts`), `ServeA2AOptions` takes `{ executor, agentCard?, port?, host?, pingHandler?, taskStore?, contextBuilder?, logger? }` — **an executor, and no `requestHandler`**. `buildA2AApp` constructs the handler itself:

```ts
const requestHandler = new DefaultRequestHandler(
  agentCard, options.taskStore ?? new InMemoryTaskStore(), options.executor
)
```

and passes it straight to `jsonRpcHandler`. There is no seam. A gateway must *replace* that handler, and `serveA2A` never offers the slot — so the §I shape is structurally inexpressible through it. This is not a version problem that goes away when it publishes.

### What it is still worth borrowing

Its ~80 lines of AgentCore-contract mechanics are the valuable part, and they are readable without depending on the package:

- **Port 9000 is the contract port.** Anything else and "deployed invocations will fail with http 424 because the runtime proxies to the contract port only". It reads `A2A_PORT`, deliberately ignoring `PORT`.
- **Bind `0.0.0.0` only in a container** — detected via `/.dockerenv` or `DOCKER_CONTAINER` — and `127.0.0.1` otherwise.
- **`/ping` defaults to `'Healthy'`, and a throwing custom handler degrades to `'Healthy'`** rather than failing the probe. So the A2A path does **no** busy tracking: `HealthyBusy` is entirely AgentForge's to implement, confirming `ARCHITECTURE.md` §4.
- **Authentication is terminated by AgentCore in front of the container**, so inside it uses `UserBuilder.noAuthentication`. AgentForge does the same; the microVM boundary is the trust boundary.
- **`bedrockCallContextBuilder`** mirrors the AgentCore-injected headers into `ServerCallContext.state`, so an executor reads them without ambient state.
- **`legacyCompat: { enabled: true }` on both the card handler and the JSON-RPC handler**, because "AgentCore's documented card shape still speaks A2A v0.3". *(What `buildA2AApp` does — not what AgentForge does; see the withdrawal below.)*

---

## Protocol version: absence means 0.3, and that is a trap

The header is **`A2A-Version`**. On the server side of `@a2a-js/sdk`'s Express handlers:

```ts
const requestedVersion = req.header(A2A_VERSION_HEADER) || A2A_LEGACY_PROTOCOL_VERSION;  // '0.3'
```

**An absent header is not "unspecified" — it is 0.3.** A request without it, against a card declaring only 1.0, is refused:

```json
{"code":-32009,"message":"The requested A2A protocol version '0.3' is not supported. Supported versions: 1.0",
 "data":[{"reason":"VERSION_NOT_SUPPORTED","domain":"a2a-protocol.org"}]}
```

Two consequences, both concrete:

1. **Whatever strips or fails to forward `A2A-Version` downgrades the request to 0.3.** Whether `InvokeAgentRuntime` forwards it is the single most important thing to check against AgentCore, because a silent downgrade presents as a blanket `VERSION_NOT_SUPPORTED` on every call.
2. ~~**AgentForge's card must declare a v0.3 `JSONRPC` interface and enable `legacyCompat`**~~ — **withdrawn 2026-09-22.** That followed AWS's own `buildA2AApp`, which does exactly this for the stated reason that AgentCore's documented card shape is v0.3. It was written before the header allowlist was known: once `A2A-Version` can be forwarded, 0.3 is support for nobody and `legacyCompat` turns a configuration mistake into a silent downgrade. AgentForge declares **one 1.0 interface with `legacyCompat` off** ([ADR 0014](../../adr/0014-agentforge-speaks-a2a-1-0-only.md), measured in [`agentcore-runtime-observed.md`](agentcore-runtime-observed.md)).

---

## `@a2a-js/sdk@1.2.0` is protobuf-typed, and the spec's shapes fail silently

This cost the most time and is the least documented. The 1.2.0 TypeScript types are generated from the protobuf definitions, so they are **not** the shapes the A2A specification's JSON examples show.

| Written the way the spec documents it | The actual 1.2.0 type |
|---|---|
| `{ kind: 'data', data: {...} }` | `{ content: { $case: 'data', value: {...} }, filename: '', mediaType: '' }` |
| `role: 'user'` | `Role.ROLE_USER` — a **numeric** enum (`1`) |
| `state: 'submitted'` | `TaskState.TASK_STATE_SUBMITTED` — numeric (`1`) |
| `eventBus.publish({ kind: 'task', ...task })` | `eventBus.publish(AgentEvent.task(task))` — a **wrapper**, `{ kind, data }` |
| `{ name: 'tasks/<id>' }` on get/cancel | `{ tenant: '', id: '<id>' }` |
| `sendMessage({ request: message })` | `sendMessage({ message })` on the wire |

**The failure is silent.** A part written as `{ kind: 'data', data }` serialized to `{"filename":"","mediaType":""}` — an empty part, no error, no warning — and the gateway simply found no envelope. Likewise `role: 'user'` arrived as `-1` (`UNRECOGNIZED`).

**And the server side differs from the wire side again.** Inside `A2ARequestHandler.sendMessage`, `params.message` arrives protobuf-normalized: `parts[].content.$case`, numeric `role`, and absent strings as `''` rather than `undefined`. A gateway reading the envelope must read `params.message.parts[].content.value`.

**Consequence for AgentForge:** the envelope reader and every event the executor publishes are written against the SDK's generated types with `strict` on, and are covered by a test that asserts the *received* shape rather than the sent one. Nothing here is caught by `tsc` if any `any` creeps into the path.

---

## A thrown gateway error loses its code

The gateway threw an error carrying a custom JSON-RPC code (`-32003`, `UNKNOWN_CONTRACT_HASH`). The client received:

```
name=JsonRpcTransportError   code=undefined   message="this image does not implement sha256:not-this-image"
```

The message survives; **the custom code does not**. A plain thrown `Error` is wrapped as `-32603 INTERNAL_ERROR`, because the handler only maps the SDK's own A2A error classes.

This is a reason to prefer the mapping `ARCHITECTURE.md` §4 already specifies — **a refusal → a `TASK_STATE_REJECTED` task carrying its reason** — over throwing. A rejected task gives the caller a typed, inspectable object; a throw gives it a string. The spike used throws because they were faster to write, and they work; the implementation should not copy that.

---

## The decision

**Assemble directly from `@a2a-js/sdk` and Express, and port `serveA2A`'s AgentCore-contract mechanics into AgentForge's own server.** Recorded as [ADR 0012](../../adr/0012-the-server-is-assembled-not-inherited.md), status `proposed`.

## What is still open, and needs AgentCore

- Whether `InvokeAgentRuntime` forwards `A2A-Version`, and what happens when it does not.
- Whether a client-supplied `contextId` survives the pass-through (it survives the SDK; the pass-through is untested).
- AgentCore's real 409 and 424, and whether the retryable 409 needs the client's own backoff, which A2A clients do not do on their own.
- Whether `GetAgentCard` validates what it returns.
