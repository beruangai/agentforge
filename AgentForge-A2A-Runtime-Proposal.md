# Proposal: AgentForge A2A Runtime Foundation

## Purpose

Adopt the **A2A Protocol** and the official **`@a2a-js/sdk`** as the workflow-to-agent protocol boundary for AgentForge, while keeping all Claude-specific execution behavior under AgentForge and all use-case-specific behavior under consuming projects such as StrategyFoundry and TrendBot.

This proposal explicitly does **not** use `a2a-wrapper` or `a2a-claude`.

The intended outcome is a reusable AgentForge runtime that provides:

- a production-oriented `ClaudeAgentExecutor` built directly on the official A2A `AgentExecutor` abstraction;
- middleware-style extension points around agent execution;
- reusable middleware and helpers, including an optional typed procedure registry;
- first-class structured input/output, hooks, streaming, cancellation, observability, and exact Claude Agent SDK configuration;
- minimal A2A request contracts for workflow callers;
- no requirement for consumers to expose Claude prompts, hooks, schemas, tools, or context construction over the wire.

This document should first be **vetted against the current AgentForge implementation and requirements**. Preserve existing good abstractions where they already satisfy the design rather than mechanically replacing them.

---

## Architecture Decision

### Adopt

- A2A Protocol v1.x as the external workflow-to-agent protocol.
- Official `@a2a-js/sdk`.
- `AgentExecutor`, `DefaultRequestHandler`, `ExecutionEventBus`, `TaskStore`, and official client primitives from `@a2a-js/sdk`.
- Bedrock AgentCore Runtime's native A2A hosting/proxy contract where AgentForge is deployed through AgentCore.
- Claude Agent SDK as the underlying Claude execution engine.
- AgentForge-owned middleware and utilities for composing agent behavior.

### Do Not Adopt

- `a2a-wrapper`
- `a2a-claude`
- another generic agent harness between AgentForge and Claude Agent SDK
- transport-level exposure of Claude Agent SDK configuration

The official A2A SDK already supplies the protocol/runtime primitives needed here. AgentForge should own only the Claude execution adapter and application-facing composition layer.

---

## Target Architecture

```text
StrategyFoundry / TrendBot
Temporal Workflow
        |
        | A2A command
        | minimal typed payload
        v
@a2a-js/sdk Client
        |
        v
Bedrock AgentCore Runtime
(optional transparent A2A hosting/proxy)
        |
        v
@a2a-js/sdk Server
        |
        +-- DefaultRequestHandler
        +-- TaskStore
        +-- ExecutionEventBus
        +-- cancellation / streaming / task lifecycle
        |
        v
AgentForge ClaudeAgentExecutor
        |
        v
AgentForge Middleware Pipeline
        |
        +-- tracing / correlation
        +-- execution policy
        +-- procedure registry (optional middleware)
        +-- context construction helpers
        +-- validation helpers
        +-- event mapping
        +-- consumer-defined middleware
        |
        v
Use-Case Procedure / Handler
        |
        +-- load domain context
        +-- construct exact prompt/content blocks
        +-- select tools / MCP servers
        +-- configure Claude hooks
        +-- configure structured output
        +-- configure permissions / limits
        +-- define result validation / marshalling
        |
        v
Claude Agent SDK
        |
        v
Claude
```

Temporal remains the durable workflow orchestrator. A2A represents the lifecycle of a single remote agent execution.

---

## Responsibility Boundaries

### Temporal / Consuming Project

Owns:

- durable workflow state;
- workflow retries and compensation;
- scheduling;
- orchestration across multiple agent tasks;
- selection of the business procedure/command;
- domain-level idempotency key;
- workflow-level timeout policy;
- application/domain persistence.

Temporal should **not** become aware of Claude Agent SDK internals.

### A2A / Official SDK

Owns:

- wire protocol;
- agent discovery/card;
- task IDs and task lifecycle;
- async task execution semantics;
- task retrieval;
- streaming;
- cancellation protocol;
- status and artifact events;
- protocol errors;
- push notifications where needed;
- transport implementation.

AgentForge should not reimplement these.

### AgentForge

Owns:

- `ClaudeAgentExecutor`;
- translation between A2A execution and Claude Agent SDK execution;
- middleware pipeline;
- cancellation propagation into Claude Agent SDK;
- Claude event-to-A2A event mapping;
- structured result publication;
- observability integration;
- reusable schemas/types/helpers;
- optional procedure-dispatch middleware;
- reusable execution-policy middleware;
- common Claude Agent SDK utilities.

### Consuming Project

Owns:

- named procedures/commands;
- typed procedure input;
- domain context retrieval;
- exact system/user prompt construction;
- exact content-block/message construction;
- procedure-specific tools;
- procedure-specific MCP configuration;
- Claude hooks;
- structured-output schema;
- procedure-specific limits/options;
- typed final result;
- domain-specific result marshalling.

The wire protocol must not dictate these details.

---

## AgentForge Core: `ClaudeAgentExecutor`

AgentForge should implement the official A2A `AgentExecutor` directly.

Conceptually:

```ts
class ClaudeAgentExecutor implements AgentExecutor {
  constructor(options: ClaudeAgentExecutorOptions) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Build AgentForge execution context.
    // Run middleware chain.
    // Execute Claude through the terminal runner.
    // Translate runtime events to A2A events.
    // Publish typed final artifact and terminal status.
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Resolve active execution.
    // Propagate cancellation/interrupt into Claude Agent SDK.
    // Publish canceled terminal state.
  }
}
```

The executor should be intentionally thin around the middleware pipeline. It should not know about StrategyFoundry, TrendBot, or any specific procedure names.

---

## Middleware-First Extension Model

The primary AgentForge extension mechanism should be a middleware chain.

A Koa-style model is suitable:

```ts
export type AgentMiddleware = (
  context: AgentExecutionContext,
  next: () => Promise<void>,
) => Promise<void>;
```

`AgentExecutionContext` should expose the execution state needed to compose behavior without leaking internal implementation unnecessarily.

Conceptually:

```ts
interface AgentExecutionContext {
  // A2A
  requestContext: RequestContext;
  eventBus: ExecutionEventBus;
  taskId: string;
  contextId?: string;

  // Parsed application command/input
  input?: unknown;

  // Mutable/preparable Claude invocation
  invocation?: ClaudeAgentInvocation;

  // Runtime
  abortSignal: AbortSignal;
  execution?: ClaudeExecutionHandle;

  // Result
  rawResult?: unknown;
  output?: unknown;

  // Correlation / metadata
  metadata: Record<string, unknown>;
}
```

Exact types should be derived from the current AgentForge and Claude Agent SDK APIs rather than copied literally from this proposal.

Middleware should be able to perform work both before and after `next()`:

```ts
const telemetryMiddleware: AgentMiddleware =
  async (ctx, next) => {
    const span = startSpan(ctx);

    try {
      await next();
      annotateSuccess(span, ctx);
    } catch (error) {
      annotateFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  };
```

This provides the consumer-controlled composition point currently missing from generic wrappers.

---

## Terminal Claude Runner

The middleware chain should terminate in a generic AgentForge Claude runner.

The terminal runner owns only the mechanics of executing a fully constructed Claude invocation:

```text
prepared Claude invocation
        |
        v
Claude Agent SDK
        |
        +-- streaming SDK events
        +-- tool events
        +-- hooks
        +-- structured result
        +-- usage/runtime metadata
        |
        v
AgentForge event/result translation
```

It should not construct domain prompts or infer which procedure is being executed.

The final invocation should be fully prepared before entering the terminal runner.

---

## Procedure Registry as Reusable Middleware

Procedure routing should be supplied by AgentForge as **optional reusable middleware**, not embedded into `ClaudeAgentExecutor`.

This is the expected primary pattern for StrategyFoundry and TrendBot.

Example:

```ts
const procedures = createAgentProcedureRegistry()
  .register(evaluateHypothesis)
  .register(generateStrategy)
  .register(analyzeBacktest);
```

Then:

```ts
const executor = new ClaudeAgentExecutor({
  middleware: [
    tracingMiddleware(),
    executionPolicyMiddleware(...),
    procedureMiddleware(procedures),
  ],
});
```

A consumer that does not need RPC/procedure semantics can omit this middleware and use a different composition model.

---

## Procedure Contract

A procedure should define a strict application contract while retaining complete control over the Claude invocation.

Conceptually:

```ts
interface AgentProcedure<TInput, TOutput> {
  name: string;
  version?: string;

  inputSchema: Schema<TInput>;
  outputSchema: Schema<TOutput>;

  prepare(
    input: TInput,
    context: AgentExecutionContext,
  ): Promise<ClaudeAgentInvocation>;

  finalize?(
    result: ClaudeAgentResult,
    context: AgentExecutionContext,
  ): Promise<TOutput> | TOutput;
}
```

The actual schema abstraction should align with AgentForge's current conventions, such as Zod if already standardized.

A procedure may internally compose reusable AgentForge helpers rather than implementing everything manually.

---

## Minimal A2A Command Contract

The external A2A message should remain small and application-oriented.

Example:

```json
{
  "procedure": "strategy.evaluate-hypothesis",
  "version": "2",
  "input": {
    "runId": "run-123",
    "hypothesisId": "hyp-456"
  },
  "executionId": "temporal-derived-idempotency-key"
}
```

This should normally be carried as structured A2A data, not flattened into a chat string.

The caller should **not** transmit:

- system prompts;
- prompt templates;
- Claude model messages;
- hooks;
- output schemas;
- tools;
- MCP configuration;
- permission modes;
- Claude session configuration.

These are server-side procedure implementation details.

---

## Strict Structured Input and Output

Structured contracts are mandatory for AgentForge's procedure pattern.

The expected pipeline is:

```text
A2A Data Part
   |
   v
Command envelope validation
   |
   v
Procedure input schema validation
   |
   v
Procedure prepares full Claude invocation
   |
   v
Claude structured output
   |
   v
Procedure output schema validation
   |
   v
A2A Artifact Data Part
```

Raw model prose should not become the application contract unless a specific use case explicitly chooses that behavior.

AgentForge should provide helpers for:

- extracting structured A2A data;
- validating command envelopes;
- validating procedure inputs;
- supplying Claude structured-output schemas;
- validating the returned structured result;
- emitting a final A2A artifact.

The exact Claude structured-output mechanism must use the current supported Claude Agent SDK/API capability at implementation time; do not freeze old parameter names into AgentForge's public API.

---

## Exact Prompt / Context Control

Consumers must retain full control over Claude context construction.

A procedure should be able to dynamically create:

- system prompt configuration;
- ordered message/content blocks;
- text blocks;
- images/documents where supported;
- retrieved domain state;
- previous artifacts;
- tool definitions;
- MCP servers;
- allowed/disallowed tools;
- permission behavior;
- hooks;
- max turns and other execution limits;
- structured-output schema.

AgentForge may provide builders/helpers, but should not normalize everything to a simple string prompt.

This is a hard requirement.

---

## Hooks

Claude Agent SDK hooks are procedure/runtime concerns, not A2A protocol concerns.

Consumers must be able to supply hooks as part of the invocation produced by their procedure.

AgentForge should also make reusable hook composition possible, for example:

```ts
const hooks = composeClaudeHooks(
  auditHooks(...),
  toolSafetyHooks(...),
  domainHooks(...),
);
```

Hooks should remain normal Claude Agent SDK primitives wherever practical rather than being redefined through a parallel AgentForge abstraction.

---

## Event and Streaming Model

AgentForge should translate useful Claude execution events into the official A2A event model without treating every Claude token/event as durable business state.

At minimum, support:

- task submitted/working state;
- progress/status updates where useful;
- artifact updates where the agent produces meaningful intermediate artifacts;
- final structured artifact;
- terminal completed/failed/canceled status.

Token-level or high-volume observability events do not necessarily belong in the A2A stream. They may be better emitted through OpenTelemetry/logging.

The implementation should distinguish:

```text
A2A stream
    = caller-relevant execution lifecycle / artifacts

OTel / logs
    = detailed runtime observability
```

This avoids turning A2A into an observability transport.

---

## Cancellation

Cancellation must work end-to-end:

```text
Temporal cancellation
      |
      v
A2A cancelTask
      |
      v
ClaudeAgentExecutor.cancelTask()
      |
      v
active execution handle
      |
      v
Claude Agent SDK interrupt / AbortSignal
      |
      v
A2A CANCELED state
```

AgentForge should maintain only the active-execution state needed to perform cancellation.

Cancellation behavior needs dedicated integration tests, including races between completion and cancellation.

---

## Temporal and A2A Lifecycle

Temporal remains authoritative for durable business workflow state.

An A2A `Task` should be treated as a remote execution handle, analogous to an ECS task, Batch job, or external workflow job.

Recommended correlation:

```text
Temporal Workflow
    |
    +-- Activity / logical agent task
           |
           +-- executionId (application idempotency key)
           |
           +-- A2A contextId
                  |
                  +-- A2A taskId
                         |
                         +-- Claude execution
```

Do not duplicate the entire Temporal workflow state machine inside A2A.

---

## Idempotency

A2A task IDs alone should not be assumed to provide application-level Temporal retry deduplication.

AgentForge/consumer integration should define an explicit `executionId` or equivalent idempotency key derived from stable Temporal execution identity.

Expected behavior:

```text
first Activity attempt
   -> executionId X
   -> creates A2A Task T

Activity retry
   -> executionId X
   -> resolves/reuses Task T
   -> does not start a second Claude execution
```

The implementation agent should determine the cleanest location for this behavior after reviewing the current persistence/runtime model.

---

## Task Persistence and Event Bus

Start with the official SDK interfaces:

- `TaskStore`
- `ExecutionEventBus`
- `ExecutionEventBusManager`

Do not create AgentForge-specific replacements unless required.

The official SDK supports injected implementations, so persistence/distribution can evolve independently from `ClaudeAgentExecutor`.

For AgentCore-hosted workloads, verify whether process/runtime lifetime makes the default in-memory implementations sufficient for the initial usage. If durability across runtime replacement is required, provide an AWS-backed implementation separately.

Do not prematurely mix task-store persistence with Temporal's durable workflow responsibilities.

---

## AgentCore Runtime

AgentCore Runtime should be treated as hosting infrastructure, not as the orchestration layer.

For A2A deployments it provides the runtime contract/proxy around the A2A server. AgentForge remains an ordinary A2A server implementation behind that boundary.

Target deployment:

```text
AgentCore Runtime
    |
    | JSON-RPC A2A
    v
@a2a-js/sdk server
    |
    v
ClaudeAgentExecutor
```

The implementation must conform to the current AgentCore A2A protocol contract, including server binding/port/path and Agent Card requirements.

---

## Observability

AgentForge should own a clean OpenTelemetry model independent of A2A.

Recommended trace hierarchy:

```text
agent.task
  |
  +-- procedure.prepare
  |
  +-- claude.execution
  |      |
  |      +-- tool.*
  |      +-- hook.*
  |      +-- model/runtime events as appropriate
  |
  +-- procedure.finalize
```

Propagate correlation metadata for:

- Temporal workflow ID;
- Temporal activity/logical execution ID;
- A2A task ID;
- A2A context ID;
- procedure name/version;
- Claude session ID where applicable.

A2A task/status events should complement OTel rather than replace it.

---

## Suggested AgentForge Package Shape

Exact paths should be adapted to the current repository.

```text
agentforge/
  a2a/
    server.ts
    client.ts
    types.ts
    artifacts.ts
    events.ts

  claude/
    ClaudeAgentExecutor.ts
    runner.ts
    types.ts
    event-mapper.ts
    cancellation.ts

  middleware/
    compose.ts
    types.ts
    tracing.ts
    execution-policy.ts

    procedures/
      registry.ts
      middleware.ts
      types.ts
      helpers.ts

  observability/
    tracing.ts
    metrics.ts
```

Avoid building a large framework. Each layer should exist only where it removes repeated code across consumers.

---

## Example Consumer Composition

StrategyFoundry could look conceptually like:

```ts
const procedures = createAgentProcedureRegistry()
  .register(evaluateHypothesisProcedure)
  .register(generateStrategyProcedure)
  .register(reviewBacktestProcedure);

const executor = new ClaudeAgentExecutor({
  middleware: [
    agentForgeTracing(),
    enforceExecutionPolicy({
      maxConcurrent: 4,
    }),
    procedureMiddleware(procedures),
  ],
});

export const server = createA2AServer({
  agentCard: strategyFoundryAgentCard,
  executor,
  taskStore,
});
```

A procedure:

```ts
const evaluateHypothesisProcedure = defineAgentProcedure({
  name: "strategy.evaluate-hypothesis",
  version: "2",
  inputSchema: EvaluateHypothesisInput,
  outputSchema: EvaluateHypothesisOutput,

  async prepare(input, ctx) {
    const marketContext = await loadMarketContext(input);
    const research = await loadResearch(input);

    return {
      // Exact Claude Agent SDK invocation:
      // system prompt
      // ordered content blocks
      // hooks
      // tools/MCP
      // structured output
      // limits / permissions
    };
  },

  async finalize(result) {
    return EvaluateHypothesisOutput.parse(
      result.structuredOutput,
    );
  },
});
```

The same AgentForge executor and middleware primitives should support TrendBot with a completely different procedure registry and Claude configuration.

---

## Public API Design Principles

1. **Prefer official types.** Re-export or accept official A2A and Claude Agent SDK types where that does not create an unstable public contract.
2. **Do not mirror upstream APIs unnecessarily.** AgentForge should add composition, not create parallel representations of every upstream option.
3. **Middleware is the primary customization seam.**
4. **Procedure registry is optional middleware.**
5. **Strict structure by default** for procedure input/output.
6. **No prompt flattening.** Preserve block-level Claude input capability.
7. **No A2A leakage into procedure business logic** beyond execution metadata that is genuinely useful.
8. **No Claude configuration leakage into A2A callers.**
9. **Temporal remains the workflow engine.**
10. **Keep the owned surface small.**

---

## Implementation / Vetting Tasks for the AgentForge Workspace Agent

Before implementation:

1. Review the current AgentForge runtime, current tRPC/HTTP serving layer, Claude runner, hooks, streaming, structured-output handling, observability, and cancellation behavior.
2. Identify which existing abstractions should survive unchanged.
3. Compare current behavior against the official `@a2a-js/sdk` v1.x `AgentExecutor`, `DefaultRequestHandler`, task-store, event-bus, client, streaming, and cancellation APIs.
4. Validate the current Bedrock AgentCore A2A contract.
5. Produce a concrete migration delta before making broad changes.
6. Flag any requirement that the official A2A SDK cannot satisfy cleanly.
7. Avoid introducing `a2a-wrapper`, `a2a-claude`, or another agent framework.

During implementation, prioritize:

- one minimal end-to-end A2A procedure;
- exact typed DataPart input;
- procedure-generated full Claude invocation;
- Claude structured output -> validated A2A artifact;
- streaming task lifecycle;
- cancellation;
- Temporal retry/idempotency behavior;
- OTel correlation.

Only generalize once that vertical slice works.

---

## Acceptance Criteria

The proposal is successfully implemented when:

1. AgentForge exposes a production-usable A2A server using the official `@a2a-js/sdk`.
2. AgentForge's `ClaudeAgentExecutor` implements the official `AgentExecutor` contract directly.
3. `ClaudeAgentExecutor` is consumer-neutral.
4. Consumers can compose execution behavior through AgentForge middleware.
5. AgentForge provides a reusable procedure-registry middleware.
6. StrategyFoundry/TrendBot can invoke named procedures using minimal typed A2A payloads.
7. Procedures retain complete block-level control over Claude context and prompts.
8. Procedures retain complete access to Claude Agent SDK hooks, tools, MCP configuration, permissions, and execution options.
9. Structured input and structured output are validated end-to-end.
10. A2A task streaming and cancellation work correctly.
11. Temporal retries cannot accidentally create duplicate expensive Claude executions for the same logical execution.
12. A2A is not used as a replacement for Temporal workflow state.
13. OTel carries detailed runtime observability while A2A carries caller-relevant lifecycle/artifact events.
14. AgentCore deployment complies with the current A2A runtime contract.
15. Neither `a2a-wrapper` nor `a2a-claude` is required.

---

## Rationale

This design keeps the mature and standardized pieces standardized:

- A2A defines the remote-agent lifecycle and protocol.
- `@a2a-js/sdk` implements that protocol.
- AgentCore can host/proxy the A2A server.
- Temporal owns durable workflow orchestration.
- Claude Agent SDK owns Claude's agent runtime.

AgentForge then owns the narrow layer that is genuinely specific to our systems:

**how a typed application command becomes a precisely configured Claude agent execution and how that execution becomes a typed A2A result.**

That is both smaller and more reusable than adopting an immature wrapper whose abstractions do not match the hard requirements.

---

## Current Reference Material

- Official A2A JavaScript SDK: https://github.com/a2aproject/a2a-js
- A2A Protocol specification: https://a2a-protocol.org/
- AWS AgentCore A2A Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html
- AWS AgentCore A2A protocol contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html
- Claude structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Claude Agent SDK hooks/example: https://platform.claude.com/cookbook/claude-agent-sdk-04-migrating-from-openai-agents-sdk

At the time of this proposal, the official JS SDK documents A2A v1.0 support, `AgentExecutor`, `DefaultRequestHandler`, injectable task/event infrastructure, streaming, cancellation, push notifications, and protocol extensions. AgentCore's A2A runtime contract uses JSON-RPC 2.0 over HTTP and acts as the hosting/proxy boundary for an A2A server.
