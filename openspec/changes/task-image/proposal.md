# Proposal

## Why

A task's record does not say which version of the agent ran it. A deploy leaves running sessions on the old image while new ones start on the new (ADR 0008), so once a task has ended, nothing tells which code produced its outcome. StrategyFoundry's decisions put capital at stake and must be reconstructible from the record (REQUIREMENTS, "Who it serves"; §REQ601). This is §ODO010, scheduled by the operator for A6 on 2026-10-08.

## What Changes

- **Every task records the image that ran it.** Its metadata carries `image`, which is:
  - deployed, the container URI the runtime was deployed with, its tag the asset hash of the agent's image;
  - locally, the agent image's id.

  The client's `TaskView` exposes it as `image`.
- **The server requires `AGENTFORGE_IMAGE`**, or the `image` option, and refuses to start without it.
- **Every place an agent's server starts sets it:**
  - `AgentRuntime` sets it from the runtime's own artifact, owns the variable, and exposes `image`;
  - the `serve` executor passes the agent image's id from the image target's output;
  - the integration fixtures pass a fixed value.
- **§ODO010 closes**, its outcome recorded in ARCHITECTURE.md.
- **BREAKING** on the wire: a client reading a task without `image` refuses it. No consumer is live; client and server ship in one package.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-task-execution`: a task records the image that ran it, and a caller reads it.

## Impact

- **Runtime:**
  - the server's config gains `image`;
  - the executor stamps it into the task's metadata at admission.
- **Client:** `TaskView.image`, and its wire schema requires it.
- **Infrastructure:**
  - `AgentRuntime` owns `AGENTFORGE_IMAGE`, set from the runtime's artifact;
  - `AgentRuntime.image` is the deployed container URI.
- **Plugin:** the `serve` executor passes `AGENTFORGE_IMAGE`.
- **Examples:** both e2e suites assert it.
- **The task protocol and the A2A shape are unchanged:** it is one more key in the task's metadata, which AgentForge already owns.
- **Requirements:**
  - serves §REQ601;
  - keeps §REQ701: one code path, with the value supplied locally and in the cloud.
- **Open options:** closes §ODO010.

## Non-goals

- The AgentCore runtime version, or the package's own version, on the record. The image identifies all the code that ran.
- Retrieving or rebuilding an image from its record. That is the consumer's registry policy.
- Per-run images. A task runs in one container.
