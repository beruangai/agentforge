# Spikes

Programs that answer a question in [`../docs/DESIGN_OPTIONS.md`](../docs/DESIGN_OPTIONS.md) by running against the real thing. **This directory is temporary.** It sits at the repository root, outside the Nx grouped layout, and it does not survive A0: when the workspace is scaffolded, every spike here is either **carried into a capability's `integ/`** or **deleted**.

**Which, is decided by whether its answer can drift** (`../.claude/rules/testing.md`). A spike whose answer depends on something that moves — the Agent SDK's behaviour, AgentCore's contract, an oRPC beta, what a registry serves — is not self-renewing, so it keeps being checked. A spike that settled a decision once is finished the moment its finding is recorded with its date, and a test that can only pass is maintenance without information.

**The disposition is decided now rather than at the scaffold**, while the reasoning is fresh:

| Directory | At A0 | Why |
|---|---|---|
| `kernel-settlement/` | **carry** → `libs/harness/agent/` | Every finding is Agent SDK behaviour, and the SDK moves fast. These are `e2e` — they call a real model |
| `agentcore/` | **carry** → the runtime's `integ/` | AgentCore's contract, observed. The header allowlist, the silent part strip, the ~60-second kill and the lease are all things a platform change could move silently |
| `procedure-framework/` | **carry** → `libs/harness/procedure/` | oRPC v2 is **in beta**. The `@ts-expect-error` probes are exactly what a version bump breaks, so they run as a typecheck target rather than a runtime one |
| `capability-composition/` | **carry** → `libs/harness/agent/` | Which `.claude/` layers compose is SDK behaviour, and it already changed once during this design |
| `images/`, `bundler/` | **carry** → the deploy path's `integ/` | Determinism depends on BuildKit, buildx and Bun versions. A pipeline that silently stops being reproducible is the failure this prevents |
| `sync/` | **carry** → the sync helper's `integ/` | `s7cmd` is a personal project whose dependencies are updated best-effort, and it is pinned by digest — so the pin is exactly what needs re-checking |
| `task-process/` | **delete** | It proved [ADR 0004](../adr/0004-a-process-per-task.md) against Bun and POSIX. The real executor's own tests cover the same ground against real code, so porting the fixture would test the fixture |
| `server-assembly/` | **delete** | Its mechanics become the real gateway, and the gateway's tests replace it. The AgentCore half already lives in `agentcore/` |
| `procedure-authoring/` | **delete** | It settled a decision that has since been re-decided. [The research note](../docs/research/procedure-authoring.md) keeps what still matters |

**Nothing here is load-bearing in the meantime.** No published artifact depends on this directory, and deleting it early would cost only the ability to re-run a measurement by hand.

Findings go to [`../docs/research/`](../docs/research/) with the date and the version they were read against. A negative result is recorded as precisely as a positive one.

## Running

Needs `../.env.local` (gitignored) with `CLAUDE_CODE_OAUTH_TOKEN` — `TEMP_CLAUDE_CODE_OAUTH_TOKEN` is preferred if present, which is how a short-lived token was supplied for one session and revoked afterwards. The AgentCore spikes also need `AWS_PROFILE=agentforge` and `AWS_REGION=us-west-2`; **the spikes that call a model cost money, the rest do not.**

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
| `agentcore/server.ts` | the container the AgentCore spikes drive: the §I gateway, a container id per process, `/ping` from live task count, request headers to stdout, a lease writer and a `SIGTERM` handler that records an outcome | [agentcore-runtime-observed.md](../docs/research/agentcore-runtime-observed.md) |
| `agentcore/b1-session-and-busy.ts` | §B — does a busy container receive a start, a poll and a cancel | ″ |
| `agentcore/b2-container-per-session.ts` | §B — one container per session, or a pool | ″ |
| `agentcore/b3-provisioning-window.ts` | §B — the window between `CreateAgentRuntime` and a working invoke | ″ |
| `agentcore/c1-stop-runtime-session.ts` | §C — `StopRuntimeSession`, and §I's `GetAgentCard` | ″ |
| `agentcore/c2-grace-period.ts` | §C — is the post-`SIGTERM` window fixed, or tied to being busy | ″ |
| `agentcore/c3-outcome-in-grace.ts` | §C — can a stopped container still record an outcome | ″ |
| `agentcore/a1-lease-visibility.ts` | §A — lease write and renewal cost from inside a microVM | ″ |
| `agentcore/i2-header-allowlist.ts` | §I — does the request header allowlist carry `A2A-Version`, and does 1.0 then negotiate | ″ |
| `bundler/d2-bun-bundler-determinism.sh` | §D — is `bun build` byte-identical | [image-determinism.md](../docs/research/image-determinism.md) |
| `sync/f1-s7cmd-semantics.sh` | §F — does `s7cmd` do what the design assumes | [working-directory-sync.md](../docs/research/working-directory-sync.md) |
| `capability-composition/l1-nested-scopes.ts`, `l2-what-composes.ts` | §L/D7 — which configuration composes up the tree, and where each kind stops | [capability-composition.md](../docs/research/capability-composition.md) |
| `procedure-framework/o1-contract-split.ts` | oRPC — one contract split into typed procedures (first shape; superseded by o6) | [procedure-framework.md](../docs/research/procedure-framework.md) |
| `procedure-framework/o2-link-and-context.ts` | oRPC — a custom non-HTTP link, and middleware-contributed typed context | ″ |
| `procedure-framework/o3-error-fidelity.ts` | oRPC — what survives a serialising transport | ″ |
| `procedure-framework/o4-streaming.ts` | oRPC — an event stream across a byte boundary, interleaved | ″ |
| `procedure-framework/o5-cancellation-and-typed-link.ts` | oRPC — a `ClientLink` with no cast; cancellation to the handler | ″ |
| `procedure-framework/o6-task-centric-split.ts` | oRPC — the split as three calls, narrowing through the link (naming superseded by o7) | ″ |
| `procedure-framework/o7-a2a-verbs-and-per-call-context.ts` | oRPC — A2A's verbs verbatim, root `CancelTask`, per-call context | ″ |

`agentcore/` needs the AWS environment: **`bash agentcore/setup.sh`** builds it from nothing in about two minutes — access check, ECR, the lease table, an ARM64 image, the runtime — and **`bash agentcore/teardown.sh`** removes every piece and then lists whatever is still tagged `agentforge:spike=true`, so the check is the tag rather than anyone's memory. `agentcore/build-and-push.sh <tag>` rebuilds and redeploys the image alone.

`images/` needs `bash images/setup.sh` first (a throwaway registry, a `docker-container` builder, and a `DOCKER_CONFIG` without the macOS keychain helper), and `bash images/teardown.sh` after.

## AWS

**Run `bash verify-agentcore-access.sh` first**, before asking for anything and before anyone walks away. It walks every permission the AgentCore spikes need to the end of the path — ending in a real `CreateAgentRuntime` against a deliberately nonexistent image, which fails on the image when IAM is correct and on authorization when it is not — and creates nothing. It exists because on 2026-09-22 a probe checked `iam:CreateRole`, found it denied, and asked for a role, when the permission that actually blocks `CreateAgentRuntime` is **`iam:PassRole`**. Half a fix cost the whole AgentCore half of a night.

Two pieces the `agentforge` PowerUser SSO profile cannot supply itself, both needing an admin identity:

- `create-execution-role.sh` creates the execution role AgentCore assumes. `delete-execution-role.sh` removes it.
- `agentcore-passrole-policy.json` grants the **caller** `iam:PassRole` on that role, conditioned on `iam:PassedToService: bedrock-agentcore.amazonaws.com`. Without it `CreateAgentRuntime` is refused no matter what the role allows.

`AWSPowerUserAccess` is `NotAction: ["iam:*", "organizations:*", "account:*"]`, so everything else the spikes need — `bedrock-agentcore*`, ECR, DynamoDB, S3, CloudWatch Logs — is already granted. `iam:PassRole` is the only addition.

Everything a spike creates in AWS is tagged `agentforge:spike=true` and deleted when that spike is done.
