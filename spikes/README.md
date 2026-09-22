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
| `server-assembly/i1-gateway-wrap.ts` | §I — a gateway wrapping `DefaultRequestHandler` | [a2a-server-assembly.md](../docs/research/a2a-server-assembly.md) |
| `task-process/cg1-protocol-and-cost.ts` | §C local, §G — the protocol, group kill, `/ping`, per-task cost | [task-process-and-cost.md](../docs/research/task-process-and-cost.md) |
| `images/d1-deterministic-builds.sh` | §D — deterministic builds and deploy granularity | [image-determinism.md](../docs/research/image-determinism.md) |
| `procedure-authoring/n0-decorators-on-bun.ts` | §N — do TypeScript 5 decorators work on Bun | [procedure-authoring.md](../docs/research/procedure-authoring.md) |
| `procedure-authoring/n4-judge.ts` | §N — the three styles, judged by `tsc` | ″ |

`images/` needs `bash images/setup.sh` first (a throwaway registry, a `docker-container` builder, and a `DOCKER_CONFIG` without the macOS keychain helper), and `bash images/teardown.sh` after.

## AWS

**Run `bash verify-agentcore-access.sh` first**, before asking for anything and before anyone walks away. It walks every permission the AgentCore spikes need to the end of the path — ending in a real `CreateAgentRuntime` against a deliberately nonexistent image, which fails on the image when IAM is correct and on authorization when it is not — and creates nothing. It exists because on 2026-09-22 a probe checked `iam:CreateRole`, found it denied, and asked for a role, when the permission that actually blocks `CreateAgentRuntime` is **`iam:PassRole`**. Half a fix cost the whole AgentCore half of a night.

Two pieces the `agentforge` PowerUser SSO profile cannot supply itself, both needing an admin identity:

- `create-execution-role.sh` creates the execution role AgentCore assumes. `delete-execution-role.sh` removes it.
- `agentcore-passrole-policy.json` grants the **caller** `iam:PassRole` on that role, conditioned on `iam:PassedToService: bedrock-agentcore.amazonaws.com`. Without it `CreateAgentRuntime` is refused no matter what the role allows.

`AWSPowerUserAccess` is `NotAction: ["iam:*", "organizations:*", "account:*"]`, so everything else the spikes need — `bedrock-agentcore*`, ECR, DynamoDB, S3, CloudWatch Logs — is already granted. `iam:PassRole` is the only addition.

Everything a spike creates in AWS is tagged `agentforge:spike=true` and deleted when that spike is done.
