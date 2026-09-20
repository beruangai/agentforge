# Consumers

AgentForge exists for its consumers, not for public use. They define what it must do; it decides how. Each keeps its requirements in its own repository, in a document of the same name. **Read both at the start of any design or implementation session** — together they are the specification this workspace answers to.

| Consumer | Contract | Ids | Status |
|---|---|---|---|
| StrategyFoundry | `~/workspace/beruangai/StrategyFoundry/docs/AGENTFORGE_CONTRACT.md` | H1… | Current. Items marked **M0** gate StrategyFoundry's first milestone |
| TrendBot | `~/workspace/PlayTek/trendbot-monorepo/docs/AGENTFORGE_CONTRACT.md` | T1… | Draft, seeded from TrendBot's specs; to be confirmed in a TrendBot session. Items marked **migration** gate its move off the first AgentForge |

## Rules

- **A contract states behavior, never mechanism.** "An outcome survives the worker being redeployed mid-run", not "results are written to S3". Where a consumer's document names a mechanism, treat it as the behavior it protects, and raise it.
- **AgentForge never edits a consumer's contract.** A requirement that is unclear, infeasible, or in conflict with the other consumer's is raised with the operator, in that consumer's repository.
- **Every proposal traces to contract ids.** A change here names the H and T requirements it serves and says which it leaves unmet. A capability no consumer requires is not built.
- **One consumer's need is met by configuration or by a helper it calls** — never by a branch in the harness or the runtime for that consumer.
- **The consumer owns its isolation strategy.** How runtime sessions, contexts, Claude sessions and working directories relate is its decision, and may differ procedure by procedure. AgentForge propagates them and enforces only mechanical invariants.
- **The consumer owns its side effects and their recovery.** AgentForge runs them in the before and after steps and gives them the idempotency key, the attempt, and the prior attempt's recorded state. A contract clause asking AgentForge to guarantee a consumer's side effect is raised.
- **No consumer vocabulary enters AgentForge.**
- **Staying current.** When a consumer's contract changes, review it here before the next proposal: new requirements enter `DESIGN_OPTIONS.md` or a change, and anything the architecture no longer meets is raised. Check each contract's git history for changes since the last review.

## Raised, and waiting on the operator

Both contracts are unvetted drafts, and a requirement that states a mechanism is read as the behavior it protects. These are the ones to settle before they are built against; each is in `DESIGN_OPTIONS.md` §L with its reasoning.

| Requirement | Why it is raised |
|---|---|
| **H14** | Names the mechanism — `~/.claude` and the working directory on a persistent mount — and that mechanism has since proven costly (§F). The behavior is "a session started in one container resumes in another" |
| **T4** | Procedures with no agent, the only reason a non-agent run path exists. TrendBot may move them to its own API layer instead; settle before A3 |
| **T8–T11** | Guardrail *semantics*, including a filename-date policy, stated as harness requirements. AgentForge's obligation is that supplied hooks reach the SDK and compose without loss |
| **T13** | Encodes a workaround for a specific CLI behavior as a permanent contract; §E is establishing whether it still reproduces |
| **T19** | A domain-negative result is the procedure's own output type, not an outcome kind |
| **T26** | "Side effects never commit twice" cannot be met by AgentForge alone; a container can die between a side effect and its record |
| **T29, T30** | Id derivation and normalization TrendBot can do before it calls; T30 requires a normalization whose format the same document disclaims |
| **T41** | Restates a platform gotcha about `time_of_last_update` as a requirement |
| **T44** | Straddles the scope line: secret storage is the consumer's, but "each runtime reads exactly the secrets it declares" is partly AgentForge's (§O) |

## What each consumer brings

**StrategyFoundry** — local-first for now, then AgentCore. Several Claude projects rather than one, with an isolation strategy still to settle; sessions that resume in any container; procedures and harness mounted rather than baked; one image adding Python and NautilusTrader; a usage-limit failure distinct, with its reset time, so workflows wait; every run's seed and transcript recorded, because its capital-bearing decisions must be reconstructible.

**TrendBot** — running in the cloud on the first AgentForge today ([lineage](lineage/first-agentforge.md)). One Claude project with isolation per entity; three deployed runtimes; a git lifecycle around every run — sync before, commit and push after, nothing on failure — as its own side effect in AgentForge's before and after steps; runs of up to hours; procedures that invoke no agent, in the agent container; composable fail-closed guardrails; concurrency bounded by the caller, never by AgentForge.
