# Design Options

What is not decided. Everything built or decided is in [ARCHITECTURE.md](ARCHITECTURE.md). A question here is settled by the cheapest thing that answers it — a sentence of design, or a spike against the real platform where AgentForge relies on behaviour the documentation does not guarantee — and its outcome then moves to ARCHITECTURE.md. Don't build against an open question, and don't resolve one silently; raise it with the operator.

**An id names one option for good.** Ids are `ODO###` — an *open design option* — cited in prose as `§ODO004`, like `§REQ304`. A new option takes the next id; an id is never reused, and a settled or dropped option's id is spent. **Next id: `ODO011`.** Letter ids (`§A`–`§T`) were used until 2026-09-29: the open ones were renumbered below, and a closed letter in a dated note names a question since settled.

| | Question | Settled by | Blocks |
|---|---|---|---|
| **ODO001** | Strict parsing (§REQ103): Zod's `z.object` strips undeclared keys, so an undeclared field is dropped silently unless the consumer wrote `z.strictObject`. Enforce it — refuse a contract with a non-strict object at `createClient` and `implementAgent` — or accept the consumer's schema as written | The operator | Nothing built; a consumer writing `z.strictObject` is strict today |
| **ODO002** | A transcript view (§REQ602): the CLI's export, its mapping onto `gen_ai.*` and the per-agent counts and dashboard are built (ARCHITECTURE §7), but the CLI does not emit `gen_ai.input.messages` (at `ALL` its raw bodies only nest in spans, as TrendBot's Honeycomb mapping found), so reading a run as a conversation waits on the CLI's support or a renderer of our own over the session transcript | The CLI's support, or the operator | Nothing |
| **ODO005** | A credential broker, so a provider key never sits in the task's environment; token rotation | When a procedure needs a key beyond the subscription | Nothing yet |
| **ODO006** | Whether background work can be allowed with a deterministic final answer | A spike, when a procedure asks for background work | Nothing — it is off |
| **ODO007** | Pausing a task for a human (`TASK_STATE_INPUT_REQUIRED`) | When a consumer asks | Nothing — no consumer asks |
| **ODO008** | The Claude config directory beyond the transcript: resuming a session from the store runs the CLI with a fresh `CLAUDE_CONFIG_DIR` holding only credentials, `.claude.json` and the user `settings.json` ([research](research/claude-agent-sdk.md)). The transcript persists (§REQ402); whether a resumed run misses anything else the config directory held — nothing is put at user scope in the base image today — is not measured | A spike, when a procedure resuming in another container finds something missing | Nothing yet |
| **ODO010** | The artifact version on a task's record: a deploy leaves running sessions on the old version while new ones start on the new (ADR 0008), so which version ran a task is not on its record. Buildable small — the construct names the image's asset hash to the server, which stamps it on every task | When a failure needs telling one version's runs from another's | Nothing |

## Tabled

- **A local S3-compatible server** (§ODO009). Local runs name no session bucket and keep transcripts in their container; a server is chosen when a local test needs the store.
- **Mounts** (S3 Files, EFS). A mount means VPC network mode and everything it drags in; state persists through APIs ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). A consumer that needs one configures it in its own CDK.
- **AgentCore Identity as a secret provider** (§ODO004 closed). Secrets Manager is the default and sufficient for consumers; Identity is added beside it when a consumer needs what it offers.
- **Streaming and blocking sends.** Polling serves long-running workflow steps; added when a procedure's latency warrants it.
