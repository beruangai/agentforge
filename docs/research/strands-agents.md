# Strands Agents — checked 2026-10-23

What the `strands` framework relies on (`openspec/changes/strands-framework`). `@strands-agents/sdk` 1.22.0 under Bun 1.4.0, each agent in a child process as a task process runs. The checks used a scripted Messages API (SSE), unless they say otherwise. Sources are the SDK's published `dist/` and the [docs](https://strandsagents.com).

## Bun, peers, one Anthropic SDK
- **Runs under Bun.** The SDK and Cedar's wasm run under Bun in a child process. Against the real API (`claude-haiku-5-5`), two runs in two processes each settled a structured output, with `stopReason` `toolUse`.
- **One Anthropic SDK.** `@anthropic-ai/sdk` resolves to one copy, `0.128.0`, shared with `@anthropic-ai/claude-agent-sdk@0.3.280`.
  - The SDK peers `^0.109.1`, which `0.128.0` does not satisfy. Bun installs it with no warning, and the provider's streaming, tool use and cache points work on it.
  - npm's strict peer resolution would refuse the pair. Consumers install with Bun.
- **Peers used,** all optional to the SDK:
  - `@anthropic-ai/sdk`, `@aws-sdk/client-s3`;
  - `@cedar-policy/cedar-wasm` ^4, and `@cedar-policy/mcp-schema-generator-wasm` ^0.6, which the Cedar intervention imports statically;
  - the OpenTelemetry SDK and exporters, for telemetry.
- **Required peers:** `@modelcontextprotocol/client` ^2, `@opentelemetry/api` ^1.9 and `zod` ^4.5.
  - The OpenTelemetry SDK 2.12 packages cap the API below 1.10, so the API is pinned at 1.9.1.
- **Unused:** `@a2a-js/sdk` (peered `^0.3.10`, against AgentForge's 1.2.0), since Strands' A2A server is not used.
- **A hard dependency:** `@aws-sdk/client-bedrock-runtime`, installed whatever the provider.

## Storage
- **One `Storage` interface.** `@strands-agents/sdk/storage` exports it, with `S3Storage(bucket, { prefix, s3Client })`. Sessions (`SessionManager` over the agent's storage), `FileMemoryStore` and `ContextOffloader` all take it.
- **Sessions resume across processes.** A session resumes in a second process, against the local store (SeaweedFS, path-style) and against AWS S3 as the test role in `us-east-2`. Its key is `<prefix>session/<id>/scopes/agent/agent/snapshots/snapshot_latest.json`.
- **Memory:**
  - `FileMemoryStore({ name, writable: true, storage })` writes `memory/<name>/<slug>.md` under the storage's prefix itself. So the prefix is `<agent>/`, and the store is named for the memory space. A second process recalled the memory.
  - `add_memory` is offered only with `addToolConfig: true`; `search_memory` is offered by default.
  - Writes wait by default (`waitForWrites: true`). A failed `add_memory` reaches the model as a tool error, not a run failure.
- **Offloading:** `ContextOffloader({ storage, maxResultTokens, previewTokens })`, with `previewTokens` < `maxResultTokens`. It writes `<prefix>offloader/<toolUseId>` and offers `retrieve_offloaded_content`. It evicts an entry after 20 cycles by default (`evictAfterCycles`, `null` to disable) through `storage.delete`, swallowing a refused delete.

## Structured output
- **A hook refuses in turn.** `BeforeToolCallEvent.cancel = '<reason>'` on `strands_structured_output` reaches the model as an `is_error` tool result carrying the reason, and its next submission is accepted.
- **A hook that throws does not end the run:** Strands swallows the throw and continues. `agent.cancel()` from the hook ends the invocation at once with `stopReason` `cancelled`.
- **Two submissions in one message,** one refused and one accepted, do not settle: Strands continues, then fails.
- **A forced tool choice is refused.** When the model ends its turn without submitting, Strands forces the tool next cycle (`tool_choice: { type: 'tool' }`), then throws `StructuredOutputError`. Opus 5.5, Sonnet 5.5 and Fable 5.1 reject forced tool use with a 400 ([errors](https://platform.claude.com/docs/en/api/errors)).

## Cache points
- **Where a cache point lands.** A `CachePointBlock({ ttl: '1h' })` after a block becomes `cache_control: { type: 'ephemeral', ttl: '1h' }` on that block, in `system` and in a message. With no `cacheConfig`, nothing else is marked.
- **A second run reads the cache.** Against the real API (`claude-haiku-5-5`), a ~13k-token system prefix ending in a cache point recorded:
  - run 1: `cacheWriteInputTokens` 13,160;
  - run 2, in another process with another question: `cacheReadInputTokens` 13,160 and `cacheWriteInputTokens` 0.
- **Usage fields:** `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadInputTokens` and `cacheWriteInputTokens`, with no cost.

## Cancel mid-tool
- **The vended shell does not see a cancel.** `makeShell` passes only `timeout` to the sandbox, so a cancel waits for the command: a 30 s `sleep` took 30,033 ms.
- **A signalled sandbox ends it quickly.** `Sandbox.execute` takes a `signal` that kills the process. A `Sandbox` subclass delegates to the agent's own sandbox and adds `agent.cancelSignal`. Bound with `makeShell(sandbox)`, which binds only an `instanceof Sandbox`, it ends the run 13 ms after the abort.
- **The command's child survives briefly.** The SDK kills `sh`, not its process group, so the command's child outlives it until it exits. The runtime already SIGKILLs the task's process group when a task ends.
- **Cancel mid-model-call.** The Anthropic provider passes no signal to its request, so a cancel waits for the model's next event; against a response that sends none, it never ends. The Anthropic client's own `fetch`, given the agent's `cancelSignal`, ends it at once (the runner's unit tests, scripted API).
- **A model call can be refused.** `BeforeModelCallEvent.cancel = '<text>'` skips the request and ends the turn with that text as the assistant's message.

## Errors
- **A provider error arrives wrapped.** The model's `streamAggregated` wraps whatever the provider threw in a `ModelError`, with the Anthropic SDK's `APIError` as its `cause`; a 429 arrives as `ModelThrottledError`, also with the `APIError` as its cause. A connection timeout arrives as a `ModelError` over `APIConnectionTimeoutError`, with no status and the name `Error`: only its class names it.

## Write scope
- **Cedar refuses outside the write globs, in turn.** `CedarAuthorization` with a `contextEnricher` computes `withinWriteScope` from the vended `fileEditor` input: picomatch over the path relative to the mount. An outside `create` is refused ("DENIED: Access denied by Cedar policy: policy1"), and an inside one is permitted.
- **The vended tool** is named `fileEditor`, with commands `view`, `create`, `str_replace` and `insert`.

## Layers and the image
- **No convention in the SDK.** The SDK has no instruction-file or directory convention.
- **The harness's convention.** `@strands-agents/harness` 0.3.1 uses `AGENTS.md` at the root (`plugins/environment`, capped at 16,000 characters), and `./.agent/skills`, `./.agent/memory` and `./.agent/sessions`. Skills are agentskills.io `SKILL.md` directories, loaded by the SDK's `AgentSkills({ skills: [paths] })`. So a layer carries `AGENTS.md` and `.agent/skills/<skill>/SKILL.md`.
- **No bash needed.** The vended shell runs `sh -c` through the sandbox, so `agentforge/a2a-strands` needs no bash.

## The spend limit
Per the [errors](https://platform.claude.com/docs/en/api/errors) and [rate limits](https://platform.claude.com/docs/en/api/rate-limits) docs:
- **The tier's spend cap:** 429 `rate_limit_error`, no `retry-after`, `error.details.error_code` `enforced_spend_limit_reached`.
- **A spend limit set in the Console:** 400 `invalid_request_error`, whose message starts "You have reached your specified API usage limits" (or "…workspace API usage limits"). The docs name no field for it.
  - The operator chose to classify it by that prefix, without a live test, as a recorded exception to §REQ501.

## What the runner does because of these
- **It records the first accepted submission itself,** and ends the run once it has one.
- **It ends a run with `agent.cancel()`** after recording the cause, whether at the structured-output cap or for a throwing guard.
- **It ends a run that stops without submitting as `OUTPUT_INVALID`,** before Strands' forced request.
- **It does not bind a signalled sandbox.** The SDK's default sandbox is not reachable through its public API. A cancel mid-command is bounded by the executor's grace and process-group kill.
- **It gives the Anthropic client a `fetch` that takes the agent's cancel signal,** so a cancel or a run's end stops a model call in flight.
- **It refuses the next model call once a submission is accepted,** and cancels the invocation.
- **It classifies a provider error from the `ModelError`'s cause,** and a connection error by its class's name.
- **It never evicts offloaded results,** since the agent's role may not delete.
- **It fails a run whose memory write failed,** with `EXECUTION_ERROR`.
- **Its storage prefix is `<agent>/`,** with the memory store named for the space.
- **`prepare()` stays synchronous:** storage and telemetry set up without awaiting.
- **The seam changes the apply made:** `TranscriptLocation.projectKey` is optional, `claude`'s alone; the context block's rendering and distillation moved into `server/harness/`.
