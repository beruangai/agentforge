# AgentCore Runtime — Verified Facts

Read at the source on 2026-09-17 to 20. Each fact cites the page it came from; re-read before relying on one, because the platform moves fast. Facts marked **operator** come from running TrendBot on AgentCore, not from documentation. Questions the documentation does not answer are in [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) and are settled by spike.

## Limits

From [AgentCore Runtime quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html):

| Limit | Value | Adjustable |
|---|---|---|
| Synchronous request timeout | 15 minutes | No |
| `InvokeAgentRuntimeCommand` timeout parameter | 1–3,600 s, default 300 | — |
| `InvokeAgentRuntimeCommand` command size | 1 byte – 64 KB | No |
| Hardware per session | 2 vCPU / 8 GB | No |
| Streaming connection duration | 60 minutes | No |
| Asynchronous job duration | 8 hours | No |
| Idle session timeout | 15 minutes | Yes — `idleRuntimeSessionTimeout` |
| Maximum session lifetime | 8 hours | Yes — `maxLifetime` |
| Payload size | 100 MB | No |
| `runtimeSessionId` length | at least 33 characters | — |

## Sessions

From [isolated sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html):

- "Each user session in AgentCore Runtime receives its own dedicated microVM with isolated Compute, memory, and filesystem resources." A session is created on the first invocation with a new `runtimeSessionId`, and context is preserved between invocations to it.
- The session header routes to the same microVM — `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` for both the HTTP and A2A protocols. "Without a consistent session ID, each request may be routed to a new microVM."
- Session states are **Active** (a request, a command, or background work), **Idle**, and **Stopped**. A stopped session "transitions back to Active on the next invocation and a new compute is provisioned"; the session id itself stays valid.
- Compute is ephemeral: memory and disk last only for the compute lifecycle. Session storage — a configured persistent mount — survives stop and resume ([filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)).
- While a session is being provisioned or torn down, a second operation returns a retryable HTTP 409 `RetryableConflictException`. "Already-running sessions are not affected."
- **Nothing in the documentation limits how many tasks may run inside one session, or says an invocation to a busy session is refused** — `DESIGN_OPTIONS.md` §B. The long-running guide describes the opposite pattern: start work, respond at once, and let the caller "check back later for results".

## Health and long-running work

From the [long-running agents guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html):

- `/ping` returns HTTP 200 with `{"status": "Healthy" | "HealthyBusy"}` — "Healthy" is idle and waiting, "HealthyBusy" is processing background tasks. The status describes the container, not any one task.
- A session reporting `Healthy` for 15 minutes is terminated; `HealthyBusy` keeps it alive past the idle timeout.
- `time_of_last_update` is optional; setting it on every ping prevents the idle timeout from firing and can exhaust the session quota.
- "Ensure `@app.entrypoint` handler does not perform blocking operations, as this might also block the /ping health check endpoint."

## A2A protocol

From [deploying A2A servers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html) and the [A2A protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html):

- AgentCore is "a transparent proxy layer": JSON-RPC payloads from `InvokeAgentRuntime` reach the container unmodified.
- The container must serve `0.0.0.0:9000` on ARM64: JSON-RPC 2.0 at `POST /`, the agent card at `GET /.well-known/agent-card.json`, and `GET /ping`.
- Callers reach it at `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{escaped ARN}/invocations/`, with SigV4 or OAuth.
- The documentation's examples show `protocolVersion` 0.3.0 and the `message/send` method name.
- Errors: unlike A2A's convention of HTTP 200, AgentCore returns the real HTTP status with a JSON-RPC error body — `-32051` not found (404), `-32052` validation (400), `-32053` throttling (429), `-32054` conflict (409, including the retryable "Session operation in progress, please retry", which A2A clients do not retry on their own), `-32055` runtime client error (424), `-32603` otherwise (500). `AccessDeniedException` is a plain 403.

## Filesystem and session storage

From [filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html):

- **A mounted path is available only at the time of invocation, not during initialization.** Anything the container must serve outside an invocation — the agent card among them — cannot be read from a mount.
- Mount paths must be under `/mnt/` with exactly one subdirectory level.
- Each mount has a 30-second timeout, all configured filesystems mount in parallel, and **a single failure fails the whole invocation** with HTTP 424 — the same status a container kill produces.
- S3 Files and EFS both require `networkMode: VPC`, with subnets in the mount targets' availability zones and security groups allowing TCP 2049. The container then needs NAT or endpoints for everything else it reaches, including `api.anthropic.com`, which has no VPC endpoint.
- S3 Files and EFS mounts are **shared** across sessions and agents that use the same access point; write access is granted by the execution role, and the documentation allows a read-only access point.
- **Session storage is Preview.** It is per-session rather than shared, capped at 1 GB and roughly 50 MB of metadata, reset after 14 idle days, and **wiped on a runtime version update** — a deploy destroys it. No hard links, no extended attributes.

## Stopping a session

[`StopRuntimeSession`](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopRuntimeSession.html) stops a running session. Termination timing, signal handling, and what survives on a mount are not documented — `DESIGN_OPTIONS.md` §C.

## TypeScript SDK

Package `bedrock-agentcore`, repository `aws/bedrock-agentcore-sdk-typescript`, AWS-maintained. From its [reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-typescript-sdk-reference.html) and the runtime module's own documentation:

- `serveA2A({ executor, agentCard?, pingHandler?, taskStore?, contextBuilder?, logger?, host? })` — **merged 2026-09-18 ([PR #229](https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/229)) and not yet in the published SDK reference, which documents only `BedrockAgentCoreApp`, `RuntimeClient`, Identity and CodeInterpreter.** Hosts an `@a2a-js/sdk` `AgentExecutor` on the A2A contract: JSON-RPC at `POST /`, the card at `/.well-known/agent-card.json`, `/ping`. Binds `A2A_PORT`, default 9000, deliberately ignoring `PORT`. Active tasks switch `/ping` to `HealthyBusy` automatically. `@a2a-js/sdk` and `express` are optional peer dependencies.
- `BedrockAgentCoreApp({ invocationHandler: { requestSchema, process } })` serves the HTTP protocol on 8080 instead — Fastify, JSON and SSE, `context.sessionId`.
- `addAsyncTask(name, metadata)` / `completeAsyncTask(id)` / `asyncTask(fn)` drive busy status; `getCurrentPingStatus()` resolves Forced > custom handler > automatic.
- **`InvokeAgentRuntime` and `InvokeAgentRuntimeCommand` are different APIs.** The first carries an invocation to the agent and has a fixed 15-minute request timeout with no timeout parameter. The second is the data-plane API for deterministic shell command execution in the same session, and it is the one with the 1–3,600 s timeout and the 64 KB command cap. A caller invoking a procedure uses `InvokeAgentRuntime`.

## Asynchronous calling patterns

[Asynchronous patterns for calling AgentCore agents](https://aws.amazon.com/blogs/machine-learning/asynchronous-patterns-for-calling-amazon-bedrock-agentcore-agents-in-serverless-pipelines/) (AWS, 2026-08-19):

- Blocking on `InvokeAgentRuntimeCommand` is the anti-pattern for long agents.
- One documented pattern passes a task token in the payload and completes the caller later. The Temporal equivalent, asynchronous activity completion, was set aside here: it would put Temporal credentials in the agent container and couple layer 1 to Temporal.
- Use a stable session id across retries, derived from the execution, so retries reach the same session.

## AgentCore Harness

**Operator:** the AgentCore Harness (`InvokeHarness`) is managed Strands Agents and hosts no custom harness. Not a candidate for any layer here.
