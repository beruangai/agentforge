# A2A and `@a2a-js/sdk` — Verified Facts

Read at the source on 2026-09-19/20, for [ADR 0002](../../adr/0002-a2a-is-the-boundary-contract.md). What AgentCore does with the protocol is in [`agentcore-runtime.md`](agentcore-runtime.md); what is unverified is in [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §I.

## The protocol, v1.0

From the [specification](https://a2a-protocol.org/latest/specification/):

- **A client need not be an agent.** An A2A client is "an application or agent that initiates requests".
- **Methods:** `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, `GetExtendedAgentCard`. Version 0.3 spelled them `message/send` and so on.
- **Asynchronous send:** `SendMessageConfiguration.returnImmediately: true` "MUST return immediately after creating the task, even if processing is still in progress". The default waits for a terminal state.
- **Task states:** submitted, working, completed, failed, canceled, rejected, input-required, auth-required. Terminal: completed, failed, canceled, rejected. There is no state for a lost task, and none for a typed failure cause.
- **Task ids are server-assigned.** §3.4.2: "Client-provided `taskId` values for creating new tasks is **NOT** supported". The protocol has no idempotency key.
- **`ListTasks` filters by `contextId`, `status` and `statusTimestampAfter`**, with cursor pagination — not by metadata. Nothing a caller puts in message metadata is queryable through the protocol.
- **A terminal task accepts no further messages** — an agent returns `UnsupportedOperationError`. Continuing work means a new task.
- **`contextId` groups tasks into a conversation.** An agent "MAY accept and preserve client-provided `contextId` values"; if it cannot, it "MUST reject the request with an error". §3.4.1: clients "MAY include the `contextId` in subsequent messages to indicate continuation of a previous interaction". Tasks sharing one "SHOULD be treated as part of the same conversational session", and nothing limits how many may be active.
- **`referenceTaskIds`** on a message explicitly relates it to earlier tasks. Messages also carry `metadata` and declared `extensions`.
- **`CancelTask` is idempotent**; **`SubscribeToTask`** returns the task as its first event, so nothing is lost between reading and subscribing.
- **Persistence is not required of a server**, and a client "must not rely on" task history without negotiation.

## `@a2a-js/sdk`

From its [repository](https://github.com/a2aproject/a2a-js) and `src/server/request_handler/default_request_handler.ts`:

- Stable 1.0, implementing protocol 1.0, with a compatibility layer for 0.3 deployments. Node and Bun; gRPC is Node-only.
- Server pieces: `AgentExecutor` with `execute(requestContext, eventBus)` and `cancelTask(taskId, eventBus)`; `DefaultRequestHandler`; `TaskStore`, `ExecutionEventBus` and `ExecutionEventBusManager`, all injected, with in-memory defaults and no persistent implementation shipped.
- **The executor runs in the background**: the handler does not await it — "Bus cleanup is tied to the executor's lifecycle, not the consumer's" — and `returnImmediately: true` returns after the first task event, defaulting to blocking otherwise.
- **Ids are `crypto.randomUUID()`** (uuid4), with no hook to change them: `const taskId = incomingMessage.taskId || crypto.randomUUID()` and `const contextId = incomingMessage.contextId || task?.contextId || crypto.randomUUID()`. Both use a client-supplied value when one is present, so supplying `contextId` from the client is the only way to control its format. What the handler does with a task id naming no stored task is unverified (`../DESIGN_OPTIONS.md` §I).
- `cancelTask` calls the executor when an event bus exists and otherwise publishes a canceled status directly; an executor that throws is turned into a failed task plus a status event.
- Resubscription attaches to the bus before loading the task, so events between load and subscribe are not missed.

## Powertools idempotency

From [Powertools for AWS Lambda (TypeScript) — Idempotency](https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/), considered as the mechanism for `DESIGN_OPTIONS.md` §H and kept as a reference:

- `makeIdempotent` wraps any function, not only a handler; the key comes from a JMESPath subset of one argument, hashed.
- States are `INPROGRESS`, `COMPLETE` and an internal `EXPIRED`; a concurrent call during `INPROGRESS` throws `IdempotencyAlreadyInProgressError`; an exception inside the wrapped function deletes the record so a retry runs again.
- In-progress expiry comes from the Lambda context's remaining time. **Outside Lambda an `INPROGRESS` record stays locked until `expiresAfterSeconds`** — default 3,600 — and **there is no lease renewal**.
- It caches the wrapped function's return value, which with DynamoDB is capped at the 400 KB item size.
