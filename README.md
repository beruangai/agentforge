# AgentForge

A procedure wrapper for the Claude Agent SDK, shared across projects.

A consumer declares a **procedure** — its public contract, the agent's own contract and how one becomes the other, the seed the agent starts from, its SDK configuration, and the side effects around the run. AgentForge runs it as an asynchronous **task** over A2A, on Bedrock AgentCore Runtime or locally in Docker, and returns a typed, validated outcome. Consumers own what their agents do and how they isolate them; AgentForge owns how they run.

It is delivered as an Nx plugin: generators, CDK constructs, a base image, and a caller-agnostic client with a Temporal activity factory over it.

**Status:** design stage. No implementation yet, and every [ADR](adr/README.md) is `proposed` until the operator accepts it.

Built for its consumers, StrategyFoundry and TrendBot, not for public use.

## Read

| Document | Holds |
|---|---|
| [docs/SOLUTION_SPACE.md](docs/SOLUTION_SPACE.md) | The problem, what AgentForge is, and what is out of scope |
| [docs/CONSUMERS.md](docs/CONSUMERS.md) | The consumer contracts this workspace answers to, and the rules for them |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The layers, the contract at each boundary, procedures, tasks, the runtime, the harness |
| [docs/DESIGN_OPTIONS.md](docs/DESIGN_OPTIONS.md) | What is not decided, and the spikes that decide it |
| [adr/](adr/README.md) | Why each significant decision went the way it did |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Canonical terms |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones |
| [docs/research/](docs/research/) | Verified facts about AgentCore, A2A, and the Agent SDK — re-read before relying on one |
| [docs/lineage/](docs/lineage/) | The first AgentForge: the failures it paid for, as evidence |

## Shape

```
caller (a Temporal activity, or anything) ──A2A──► agent (gateway, executor, durable task state)
                                                      └─ a process per task ──► harness ──► Claude Agent SDK
```

Four layers: **runtime** owns the wire and the task's execution host; **harness** owns procedures and the agent run; the **consumer** owns its procedures and its identifiers; the **SDK** owns the agent loop. Layers 1 and 2 never import each other, and only two crossings are protocols — the A2A wire, and the pipe to a task process.

## Consumers

- **StrategyFoundry** — `~/workspace/beruangai/StrategyFoundry`; contract in its `docs/AGENTFORGE_CONTRACT.md`
- **TrendBot** — `~/workspace/PlayTek/trendbot-monorepo`; contract in its `docs/AGENTFORGE_CONTRACT.md`; migrates off the first AgentForge once its requirements are met
