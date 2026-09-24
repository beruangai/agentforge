# Design Options

What is not decided. Everything built or decided is in [ARCHITECTURE.md](ARCHITECTURE.md). A question here is settled by the cheapest thing that answers it — a sentence of design, or a spike against the real platform where AgentForge relies on behaviour the documentation does not guarantee — and its outcome then moves to ARCHITECTURE.md. Don't build against an open question, and don't resolve one silently; raise it with the operator.

Section letters are stable ids; a closed section's letter is not reused.

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§D** | The deploy path: a construct for the runtime (V2, through a custom resource while CloudFormation lacks it), its role, the task table and the leaf image; waiting for `READY` plus a probe | Building it against `hello-agent` | A2 |
| **§S** | Strict parsing (§REQ103): Zod's `z.object` strips undeclared keys, so an undeclared field is dropped silently unless the consumer wrote `z.strictObject`. Enforce it — refuse a contract with a non-strict object at `createClient` and `implementAgent` — or accept the consumer's schema as written | The operator | Nothing built; a consumer writing `z.strictObject` is strict today |
| **§H** | Whether ids minted in containers restored from one V2 snapshot are unique — every task id and uuid7 depends on the random source reseeding | A spike on AgentCore: mint in many restored containers, compare | A2 |
| **§G** | The admission limit's default (4 today): what a 2 vCPU / 8 GB container runs at once without an out-of-memory kill | Measured on AgentCore with real runs | A2 |
| **§F** | Sessions and working directories across containers (§REQ402): the SDK's `SessionStore` over S3 for transcripts, the project key that scopes them, whether a resumed run needs more of the config directory, and how a working directory syncs | A resume spike across two containers; design with the first consumer that needs it | Cross-container resume |
| **§P** | The local S3-compatible server for §F | Chosen with §F | §F locally |
| **§T** | Telemetry and metrics (§REQ602, §REQ604): the SDK's OpenTelemetry export flushed before the outcome, and counts of lost tasks and unrecordable outcomes per agent | Design at A2, with the dashboard | A2 |
| **§K** | The Nx plugin: generators for an agent and a procedure, and the sync generator that keeps a consumer's wiring current | Extracted from what `hello-agent` needed by hand, once a second agent exists | Consumer adoption |
| **§O** | A credential broker, so a provider key never sits in the task's environment; token rotation | When a procedure needs a key beyond the subscription | Nothing yet |
| **§E** | Whether background work can be allowed with a deterministic final answer | A spike, when a procedure asks for background work | Nothing — it is off |
| **§M** | Pausing a task for a human (`TASK_STATE_INPUT_REQUIRED`) | When a consumer asks | Nothing — no consumer asks |

## Tabled

- **Mounts** (S3 Files, EFS). A mount means VPC network mode and everything it drags in; state persists through APIs ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). A consumer that needs one configures it in its own CDK.
- **Streaming and blocking sends.** Polling serves long-running workflow steps; added when a procedure's latency warrants it.
