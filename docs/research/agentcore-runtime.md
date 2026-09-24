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
| Container image size | 2 GB | No — read 2026-09-24; it bounds how much the layered agentic base images of `ARCHITECTURE.md` §6 may carry |
| Environment variables, total | 4 KB on V1; **2.5 KB on V2** for a container agent | No — read 2026-09-24, [platform versions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html#runtime-platform-versions); AWS says V2 will be raised to match |

## Regions

From [supported AWS Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html), read 2026-09-23: Runtime microVMs, Identity, Gateway, Memory, Observability and Built-in Tools are available in both `us-west-2` (prod) and `us-east-2` (where the integration tests run), so the tests exercise the same Runtime feature set as prod. The two differ only in what AgentForge does not use: the AWS Agent Registry is in `us-west-2` and not in `us-east-2`, and the Web Search Tool is in neither.

## Sessions

From [isolated sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html):

- "Each user session in AgentCore Runtime receives its own dedicated microVM with isolated Compute, memory, and filesystem resources." A session is created on the first invocation with a new `runtimeSessionId`, and context is preserved between invocations to it.
- The session header routes to the same microVM — `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` for both the HTTP and A2A protocols. "Without a consistent session ID, each request may be routed to a new microVM."
- Session states are **Active** (a request, a command, or background work), **Idle**, and **Stopped**. A stopped session "transitions back to Active on the next invocation and a new compute is provisioned"; the session id itself stays valid.
- Compute is ephemeral: memory and disk last only for the compute lifecycle. Session storage — a configured persistent mount — survives stop and resume ([filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)).
- While a session is being provisioned or torn down, a second operation returns a retryable HTTP 409 `RetryableConflictException`. "Already-running sessions are not affected."
- **Nothing in the documentation limits how many tasks may run inside one session, or says an invocation to a busy session is refused** — `DESIGN_OPTIONS.md` §B. The long-running guide describes the opposite pattern: start work, respond at once, and let the caller "check back later for results".

## Request headers

From [pass custom headers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html), read 2026-09-22:

- A runtime takes a **request header allowlist**, `requestHeaderConfiguration: { requestHeaderAllowlist: [...] }`, on `CreateAgentRuntime` and `UpdateAgentRuntime`. **Only allowlisted headers reach the container**; everything else is dropped.
- **Up to 20 headers per runtime, 4 KB per value.** Names are case-insensitive; duplicates are rejected.
- A published **restricted table** cannot be allowlisted — it includes `Content-Type`, `Content-Length`, `Accept`, `Host`, `Authorization`-adjacent headers, the CORS and security sets, and the proxy/forwarding set. Anything prefixed `x-amz-` or `x-amzn-` is refused **except** `X-Amzn-Bedrock-AgentCore-Runtime-Custom-`.
- `Authorization` may be allowlisted only when the runtime has a `customJWTAuthorizer`.
- `update_agent_runtime` is a **full PUT**: `roleArn`, `agentRuntimeArtifact` and `networkConfiguration` must be resent even when unchanged.

**`A2A-Version` is allowlistable** — a valid header name, absent from the restricted table, not `x-amzn-`-prefixed. Measured working in [`agentcore-runtime-observed.md`](agentcore-runtime-observed.md), which is why that note's earlier claim that the header is "never forwarded" was a statement about the default rather than the platform.

## Health and long-running work

From the [long-running agents guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html):

- `/ping` returns HTTP 200 with `{"status": "Healthy" | "HealthyBusy"}`. `Healthy` is "ready to accept new work"; `HealthyBusy` is "operational but currently busy with async tasks. While the status is `HealthyBusy`, the runtime session is considered active and is kept alive."
- **It is a lifecycle signal, not admission control.** Nothing in the contract says a status stops an invocation being delivered; the status decides whether the session is kept alive or reaped. Concurrency is the container's own responsibility on both protocols, and both can receive messages while work is in progress.
- **On platform version V2 the container must report healthy within 120 seconds of starting, and the first healthy `/ping` is when the snapshot is taken** — documented 2026-09-24 ([platform versions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html#runtime-v2-what-to-expect)); it was operating knowledge before. See the V2 section below.
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
- Three mount types, and their lifecycles differ in the way that matters most:

| | Isolation | On a runtime version update | Notes |
|---|---|---|---|
| Managed **session storage** (Preview, microVM) | Per session | **"Data wiped – fresh file system on next invoke"** | No VPC needed; 14-day idle reset; no hard links or xattrs |
| **Capacity provider volume** (Instances) | Per session | "Data persists – volume re-attached on next invoke" | EBS, Instances compute only |
| **S3 Files / EFS** (bring your own) | **Shared** across sessions and agents | **"No effect – data persists"** | Customer-managed and permanent; VPC required; write access from the execution role, and a read-only access point is allowed |

- So durable per-session state that must survive a deploy belongs on S3 Files or EFS, not on managed session storage.
- Mount paths must be `/mnt/<one level>`, 6–200 characters, unique, and not nested inside one another.
- **Budget per runtime:** 5 filesystem configurations in total, of which at most 2 S3 Files, 2 EFS, and 1 managed session storage. Capacity provider volumes are Instances-only and cannot be combined with the others.

## Naming constraints

From [CreateAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntime.html) and [ECR CreateRepository](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_CreateRepository.html):

- `agentRuntimeName` is `[a-zA-Z][a-zA-Z0-9_]{0,47}` — letters, digits and underscores only, **no hyphens or slashes, 48 characters maximum**, starting with a letter. The returned ARN appends a ten-character suffix of its own.
- ECR `repositoryName` is `[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*`, 2–256 characters, starting with a letter. Slashes namespace a repository — "prepended with a namespace to group the repository into a category" — and `-+` means consecutive hyphens are legal.
- So one string cannot name both. A registry path carries the readable identity; the runtime name is generated (CDK's `Names.uniqueResourceName` bounded to 48 characters), and callers address an agent by ARN.

## Versions and running sessions

From [lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html):

- "Each microVM session uses the code assets (`agentRuntimeArtifact`) that were deployed at the time of microVM creation. **If you update your agent runtime with new code, existing sessions will continue using the previous version until they terminate and new sessions are created.**"
- So a deploy does not recycle running containers and cannot interrupt a turn. Two artifact versions serve traffic while long sessions drain, which is normal rather than a fault — but a task's record has to say which artifact ran it.
- Lifecycle timers are per session: the idle timeout resets on each invocation to that session, `maxLifetime` starts at creation and cannot be reset, and when either fires only that session's microVM is terminated.
- **A termination by the idle timeout or `maxLifetime` "can last up to 15 seconds"** (read 2026-09-24) — a quarter of the ~60 s measured after `StopRuntimeSession` ([observed](agentcore-runtime-observed.md)).

## Platform version V2 — read 2026-09-24

From [platform versions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html#runtime-platform-versions) and [optimize for V2](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-v2-optimize.html). **AgentForge runs on V2** (`ARCHITECTURE.md` §5); every observation in [`agentcore-runtime-observed.md`](agentcore-runtime-observed.md) before 2026-09-24 was made on V1.

- `platformVersion` is `V1` (the default) or `V2`, set on `CreateAgentRuntime` or `UpdateAgentRuntime`; an update that omits it keeps the current one. `CreateAgentRuntime`'s response does not return it; `GetAgentRuntime` does. Available in `us-east-2` and `us-west-2`.
- **V2 restores every container from one snapshot**, taken at the first healthy `/ping`. Work done at startup is shared by every restored instance; anything that must differ per request or can expire — random values, identifiers, the current time, an elapsed-time reference, credentials — is produced per request. "`time.monotonic()` does not advance across a restore." "Every restored instance reports the same hostname (`localhost`) and PID (`1`)."
- **A cryptographic library that cached random state at startup can reuse it across instances**; a container agent must bring a snapshot-safe build that reseeds after a restore. Whether Bun's does is not documented — `DESIGN_OPTIONS.md` §H.
- Report healthy only once initialisation is done, within 120 seconds, or creation fails. Sockets opened at startup do not survive a restore; clients built and exercised at startup reconnect transparently. Do not bind a fixed source port.
- **Create and update take minutes**, not seconds, while the snapshot is prepared; `update` or `delete` before a terminal status returns `ConflictException`. A snapshot is deleted when no endpoint points at its version, which can take up to 8 hours while its sessions drain.
- **CloudFormation and the CDK cannot set `platformVersion` yet.**

## Stopping a session

[`StopRuntimeSession`](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopRuntimeSession.html) stops a running session. Termination timing, signal handling, and what survives on a mount are not documented — `DESIGN_OPTIONS.md` §C.

## TypeScript SDK

Package `bedrock-agentcore`, repository `aws/bedrock-agentcore-sdk-typescript`, AWS-maintained. From its [reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-typescript-sdk-reference.html) and the runtime module's own documentation:

- `serveA2A({ executor, agentCard?, pingHandler?, taskStore?, contextBuilder?, logger?, host? })` — **merged 2026-09-18 ([PR #229](https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/229)) and not yet in the published SDK reference, which documents only `BedrockAgentCoreApp`, `RuntimeClient`, Identity and CodeInterpreter.** Hosts an `@a2a-js/sdk` `AgentExecutor` on the A2A contract: JSON-RPC at `POST /`, the card at `/.well-known/agent-card.json`, `/ping`. Binds `A2A_PORT`, default 9000, deliberately ignoring `PORT`. `@a2a-js/sdk` and `express` are optional peer dependencies.
- **The A2A path does no busy tracking.** Read at `abafc2a`: its ping handler is `status = (await options.pingHandler?.()) ?? 'Healthy'`, and a failing custom handler degrades to `Healthy` rather than failing the probe. `HealthyBusy` appears only in a comment about shedding work. The HTTP path is the one that tracks automatically — `BedrockAgentCoreApp.getCurrentPingStatus()` resolves forced status, then a custom handler, then `this._activeTasksMap.size > 0 ? 'HealthyBusy' : 'Healthy'`.
- So on A2A the ping policy is the server's own, and the two protocols differ: the HTTP path reports busy while any task runs, which suits one task at a time.
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
