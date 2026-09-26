# Design Options

What is not decided. Everything built or decided is in [ARCHITECTURE.md](ARCHITECTURE.md). A question here is settled by the cheapest thing that answers it — a sentence of design, or a spike against the real platform where AgentForge relies on behaviour the documentation does not guarantee — and its outcome then moves to ARCHITECTURE.md. Don't build against an open question, and don't resolve one silently; raise it with the operator.

Section letters are stable ids; a closed section's letter is not reused.

| | Question | Settled by | Blocks |
|---|---|---|---|
| **§S** | Strict parsing (§REQ103): Zod's `z.object` strips undeclared keys, so an undeclared field is dropped silently unless the consumer wrote `z.strictObject`. Enforce it — refuse a contract with a non-strict object at `createClient` and `implementAgent` — or accept the consumer's schema as written | The operator | Nothing built; a consumer writing `z.strictObject` is strict today |
| **§F** | Working directories: the optional filesystem a consumer declares so its agents persist and share artifacts, which AgentForge syncs and verifies before an outcome is published ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). The session store it rests beside is built (ARCHITECTURE §6) | Designed with its first consumer, TrendBot's vault | That consumer's adoption |
| **§T** | Telemetry and metrics (§REQ602, §REQ604): the CLI's export and its mapping onto `gen_ai.*` are built (ARCHITECTURE §7); open are counts of lost tasks and unrecordable outcomes per agent, and a transcript view: the CLI does not emit `gen_ai.input.messages` (at `ALL` its raw bodies only nest in spans, as TrendBot's Honeycomb mapping found), so reading a run as a conversation waits on the CLI's support or a renderer of our own over the session transcript — later | Design at A2, with the dashboard | A2 |
| **§K** | The Nx plugin: generators for an agent and a procedure, and the sync generator that keeps a consumer's wiring current. Every agentic and agent layer it generates has `files/$claude/`, which its Dockerfile always copies as `.claude/`, scaffolded with placeholders for the consumer to fill — `skills/`, `agents/`, `settings.json` | Designed from [`examples/agentic-project`](../examples/agentic-project), built by hand — its per-layer `lock` and image targets are the first executors to extract | Consumer adoption |
| **§I** | Identity through AgentCore Identity: the subscription token, and any identity a consumer adds, held by one mechanism, replacing the Secrets Manager stopgap (`AgentRuntime`'s `secrets`) | The operator provides the design | Consumer adoption |
| **§O** | A credential broker, so a provider key never sits in the task's environment; token rotation | When a procedure needs a key beyond the subscription | Nothing yet |
| **§E** | Whether background work can be allowed with a deterministic final answer | A spike, when a procedure asks for background work | Nothing — it is off |
| **§M** | Pausing a task for a human (`TASK_STATE_INPUT_REQUIRED`) | When a consumer asks | Nothing — no consumer asks |

## Tabled

- **A local S3-compatible server** (§P). Local runs name no session bucket and keep transcripts in their container; a server is chosen when a local test needs the store.
- **Mounts** (S3 Files, EFS). A mount means VPC network mode and everything it drags in; state persists through APIs ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). A consumer that needs one configures it in its own CDK.
- **Streaming and blocking sends.** Polling serves long-running workflow steps; added when a procedure's latency warrants it.
