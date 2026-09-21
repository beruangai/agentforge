# Spikes

Throwaway programs that answer a question in [`../docs/DESIGN_OPTIONS.md`](../docs/DESIGN_OPTIONS.md) by running against the real thing. **These are not the final home.** `ARCHITECTURE.md` §9 requires every spike to land as an integration test in a capability's `integ/`, so its answer is re-checked as the platform moves rather than recorded once and trusted. They live here only until the Nx workspace exists to hold them.

Findings go to [`../docs/research/`](../docs/research/) with the date and the version they were read against. A negative result is recorded as precisely as a positive one.

## Running

Needs `../.env.local` (gitignored) with `CLAUDE_CODE_OAUTH_TOKEN`, and for the AgentCore spikes `AWS_PROFILE=agentforge`, `AWS_REGION=us-west-2`.

```bash
bun install
bun kernel-settlement/e1-foreground-settlement.ts
```

Each spike takes an optional list of scenario names, so a single case can be re-run without paying for the rest:

```bash
bun kernel-settlement/e4-option-binding.ts maxTurns maxBudgetUsd
```

Every message of every run is written to `out/<spike>.jsonl`, and a machine-readable summary to `out/<spike>-summary.json`. Both are gitignored: the findings are the deliverable, not the logs.

## What is here

| Spike | Answers | Findings |
|---|---|---|
| `kernel-settlement/e1-foreground-settlement.ts` | §E — does a final submission survive foreground dispatch | [kernel-settlement.md](../docs/research/kernel-settlement.md) |
| `kernel-settlement/e2-background-settlement.ts` | §E — background work and the resumed turn | ″ |
| `kernel-settlement/e3-in-turn-correction.ts` | §E — `PreToolUse` rejection vs native re-prompting | ″ |
| `kernel-settlement/e4-option-binding.ts` | §E — does every option bind | ″ |

## AWS

`create-execution-role.sh` creates the AgentCore execution role the AgentCore spikes need. It requires IAM rights that the `agentforge` PowerUser SSO profile **does not have**, so an operator runs it. `delete-execution-role.sh` removes it.

Everything a spike creates in AWS is tagged `agentforge:spike=true` and deleted when that spike is done.
