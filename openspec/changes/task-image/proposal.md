# Proposal

## Why

A task's record does not say which version of the agent ran it. A deploy leaves running sessions on the old image while new ones start on the new (ADR 0008), so once a task has ended, nothing tells which code produced its outcome. StrategyFoundry's decisions put capital at stake and must be reconstructible from the record (REQUIREMENTS, "Who it serves"; §REQ601). This is §ODO010, scheduled by the operator for A6 on 2026-10-08.

## What Changes

- **Every task records the image that ran it.** Its metadata carries `image`, which is:
  - deployed, the container URI the runtime was deployed with, its tag the asset hash of the agent's image;
  - locally, the agent image's id.

  Every task carries it, a start rejected at admission for its size included. The client's `TaskView` exposes it as `image`.
- **The server requires `AGENTFORGE_AGENT_IMAGE`**, or the `image` option, and refuses to start without it. As with the agent's name, whatever starts the server sets it, and the server's config is its one source.
- **Every place an agent's server starts sets it:**
  - `AgentRuntime` sets it from the runtime's own artifact, owns the variable, and exposes `image`;
  - the `serve` executor runs the agent's image by the id the image target wrote, and passes that id;
  - `integ/local/runtime` passes the option; the AgentCore fixture's `AgentRuntime` sets it like any deployed agent's.
- **§ODO010 closes**, its outcome recorded in ARCHITECTURE.md.
- **BREAKING** on the wire: a client reading a task without `image` refuses it. No consumer is live, and the wire rule `strict-contracts` records in ARCHITECTURE §7 covers it: a project and its callers take the new version in one deploy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-task-execution`: a task records the image that ran it, and a caller reads it.

## Impact

- **Runtime:**
  - `ServerConfig` gains `image`;
  - the executor and the gateway take it in their configs, and `taskMetadata` stamps it at admission and on a start rejected for its size.
- **Client:** `TaskView.image`, and its wire schema requires it.
- **Infrastructure:**
  - `AgentRuntime` owns `AGENTFORGE_AGENT_IMAGE`, set from the runtime's artifact;
  - `AgentRuntime.image` is the deployed container URI.
- **Plugin:** the `serve` executor runs the image by its id and passes `AGENTFORGE_AGENT_IMAGE`.
- **Examples:** `smoke-coverage`'s e2e suites assert it; its infrastructure outputs `HelloAgentImage`.
- **The task protocol and the A2A shape are unchanged:** it is one more key in the task's metadata, which AgentForge already owns.
- **Batch:** the last of four A6 changes, applied in order with no deploy between them: `glibc-base-image`, `strict-contracts`, `project-infrastructure`, `task-image`. Its last group is the batch's joint verification, run once after all four are applied, against the stacks `glibc-base-image` destroyed first. Overlaps:
  - `project-infrastructure` reshapes `AgentRuntime` and the AgentCore fixture first; this change adds `image` to the reshaped construct and deploys the fixture through `AgenticProjectResources`;
  - `glibc-base-image` and `project-infrastructure` also edit `smoke-coverage`'s AgentCore suite; its `HelloAgentImage` output sits beside the project's `SessionBucketName`.
- **Requirements:**
  - serves §REQ601; leaves none unmet;
  - keeps §REQ701: one code path, with the value supplied locally and in the cloud.
- **Open options:** closes §ODO010.

## Non-goals

- The AgentCore runtime version, or the package's own version, on the record. The image identifies all the code that ran.
- Retrieving or rebuilding an image from its record. That is the consumer's registry policy.
- Per-run images. A task runs in one container.
