---
status: accepted
date: 2026-09-20
decision-makers: Jeremy Jonas
---

# Identity and isolation are the consumer's

## Context and Problem Statement

Five identifiers meet in one task: AgentCore's `runtimeSessionId`, A2A's `contextId`, and the Claude Agent SDK's `sessionId`, `cwd` and working directory. They come from three systems and isolate or continue different things. A harness can define how they relate — one runtime session per context, one task per Claude session — and that would make a tidy model. Should it?

## Considered Options

* **AgentForge defines the mapping** — one rule for every consumer, for example runtime session = context = Claude project
* **AgentForge defines defaults** a consumer may override
* **The consumer decides**; AgentForge propagates and enforces only mechanical invariants

## Decision Outcome

Chosen option: **the consumer decides**, because isolation strategy is a use-case decision that already differs: TrendBot runs one Claude project with isolation per entity, while StrategyFoundry expects several projects and may isolate by strategy, by iteration, or by procedure — and either may differ procedure by procedure. A mapping fixed here would be in the way within a milestone.

* Every identifier is explicit in the envelope or the procedure's configuration; AgentForge carries, propagates and records them
* The invariants it does enforce are mechanical: at most one container at a time per runtime session (the platform's), one process per task, one live task per continuity key, and no concurrency ceiling of its own beyond what the container's memory allows (D15)
* A task that would take a continuity key a live task holds — in practice a Claude session id — is rejected loudly; forking is available where a branch is wanted
* The agent card, and how many runtimes a consumer deploys, follow the same rule: configuration, not policy

### Consequences

* Good, because a consumer changes its isolation strategy without a change here
* Good, because the invariants that remain are enforceable mechanically, with no knowledge of the use case
* Bad, because AgentForge cannot optimize for a shape it does not assume, and a consumer can choose a combination that performs poorly
* Bad, because every identifier has to be threaded through the envelope, the record, and the telemetry rather than derived
