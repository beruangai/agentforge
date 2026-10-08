# Design

## Context

See proposal.md — Why. What holds today:

- **The AgentForge image** (`libs/agentforge/Dockerfile`):
  - It is `FROM oven/bun:1.4.0-alpine`, pinned by digest, with `apk add bash git ca-certificates ripgrep`.
  - It copies the collector (a static Go binary) and `s7cmd` (the static musl aarch64 build, sha256-pinned) in from their own stages.
  - It runs as the image's `bun` user (uid 1000), with `/workspace` as a Bun workspace.
  - The AgentCore integ fixture reads `ARG BUN_IMAGE` from this file (`integ/__fixtures__/pinned-base-image.ts`).
- **The layers above it** (ARCHITECTURE §7):
  - The base layer's and each agent's Dockerfiles are maintained by the plugin.
  - The plugin's documentation already says: "Extend an image in its layer's `package.json` first; detach a `Dockerfile` only for what a manifest cannot say."
  - ADR 0010 already names an agent "adding Python and NautilusTrader" as one whose layer extends the image (§REQ704).
- **The worker image** (`workflow-project.ts`, `workerDockerfile`): its dependency stage is `FROM` the same Alpine pin and runs `bun install`; its runtime stage is `node:…-slim`, which is Debian. The installed `node_modules`, including the Temporal core's native bridge, are copied from musl to glibc.
- **The SDK's native CLI**: `@anthropic-ai/claude-agent-sdk` lists both `linux-arm64` and `linux-arm64-musl` packages, and picks between them at run time. The lock already holds both.
- **Observed 2026-10-08:**
  - **NautilusTrader 1.231.0 on PyPI** publishes:
    - `manylinux_2_35_aarch64` and `manylinux_2_35_x86_64` wheels for CPython 3.12–3.14;
    - macOS and Windows wheels;
    - an sdist;
    - no musllinux wheel.
  - **`oven/bun:1.4.0-slim`** is Debian 13 (trixie) for `arm64` and `amd64`. It creates the `bun` user and group at uid and gid 1000, as the Alpine image does. Debian 13 ships glibc 2.41 and Python 3.13.

## Goals / Non-Goals

**Goals:**
- An AgentForge image on which glibc-only prebuilt binaries install and run on ARM64.
- Everything the image did before still works, locally and on AgentCore.
- One proven, documented route for a layer to add what its manifest cannot say.

**Non-Goals:** as in proposal.md.

## Decisions

### The AgentForge image is `oven/bun:1.4.0-slim`

```dockerfile
ARG BUN_IMAGE=docker.io/oven/bun:1.4.0-slim@sha256:<index digest, resolved when implemented>
…
FROM ${BUN_IMAGE}
COPY --from=collector /awscollector /usr/local/bin/aws-otel-collector
COPY --from=s7cmd /usr/local/bin/s7cmd /usr/local/bin/s7cmd
# The Claude CLI's Bash tool needs bash, named by SHELL; git and ripgrep are its tools'.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends bash git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace/agentforge /workspace/agentic/agent \
 && chown -R bun:bun /workspace
USER bun
…   # unchanged
```

`-slim` rather than `-debian`, because it carries nothing AgentForge or a run uses beyond what is listed. The `s7cmd` stage moves to the same pin, and `tar` is in Debian's base. `s7cmd` stays the static musl build: a static binary runs on either C library, and it is the build `integ/aws/filesystem-s3-sync` verified, so ADR 0015's pin holds unchanged. The reasoning for the distribution is [ADR 0018](../../../adr/0018-the-agentforge-image-is-debian.md), proposed: a future reader proposing Alpine for its size is the reader it is for.

*Alternatives:*
- **Keep Alpine and let a consumer build from source.** That puts a Rust and Cython build of NautilusTrader in every image build, on ARM64, and it repeats for every library published only for glibc.
- **Keep Alpine and install `gcompat`.** That shims only part of glibc's ABI; `manylinux` wheels are not supported on it, and pip refuses to install them.
- **A per-consumer base image.** A second image chain to maintain, for a need every glibc-only library shares.

### The worker's dependency stage takes the same pin

`workflow-project.ts`'s `BUN_IMAGE` becomes the slim pin. The stage then installs the Temporal packages on the C library that the Node runtime stage runs them on, so no native package is chosen for musl and run on glibc. It is the same Bun version, and the change regenerates `golden-kata-workflows/container/Dockerfile` through sync.

### A layer adds what its manifest cannot say by detaching its Dockerfile

This is the route the plugin's documentation already gives, now proven and spelled out. `smoke-coverage` detaches `base/Dockerfile` in its `project.json` and writes:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Python for every agent in the project, before the layer's own files so it
# is cached across their changes; installed as root, then back to bun.
USER root
RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/python \
 && /opt/python/bin/pip install --no-cache-dir --only-binary=:all: nautilus_trader==1.231.0
USER bun
ENV PATH=/opt/python/bin:${PATH}
COPY …   # the maintained lines, unchanged
```

- `--only-binary=:all:` makes a missing wheel fail the build, so the proof can never pass by building from source.
- The venv sidesteps Debian's externally managed system Python (PEP 668).
- `ENV PATH` reaches the server, every task process and the CLI's Bash tool, which inherit the image's environment.

The base layer is the place for it because ADR 0010 puts a project's shared capabilities there. An agent layer that alone needs a package detaches its own Dockerfile the same way.

*Alternative:* a plugin seam that keeps the Dockerfile maintained, such as a scaffolded install script the maintained file runs as root. It would keep AgentForge's updates flowing into the file, but it is a second route for a need with one consumer, and Docker has no include. If StrategyFoundry's detached file drifts painfully from what sync would write, that is the evidence for it.

### `hello-agent`'s `Python` procedure

- **The contract:** `Python` takes `{}` and returns `{ version: string }`.
- **The run:** its agent runs `python -c "import nautilus_trader; print(nautilus_trader.__version__)"` with Bash and answers with what it printed. It has `tools: ['Bash']` and `allowedTools: ['Bash(python *)']`, in `dontAsk`, over the base options.
- **The e2e:** it asserts the version is `1.231.0`, locally and on AgentCore.

A procedure always runs an agent (REQUIREMENTS: settled), and an agent running Python through Bash is exactly the use the image serves. The fence does not bound Bash that is not read-only, which is already a known limit and unchanged.

*Where:* `smoke-coverage` rather than `golden-kata` or a new example. It holds what AgentForge does around a run, and a third project would add another deployment for one procedure. The cost is a larger `smoke-coverage` base image; the Python layer is cached ahead of the layer's own files.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| No wheel for the platform | building the base layer's image | the build fails, naming the package; nothing is compiled |
| A Debian package missing | building the AgentForge image | the build fails |
| Python or the library missing at run time | the agent's Bash call | the agent cannot answer the version; the e2e fails on its answer |
| The image running as root | — | never: every Dockerfile ends on `USER bun`, and the CLI refuses unattended tools as root |

## What earns which test

- **No new unit test.** Nothing in the package's TypeScript changes, except the worker template's pin, which its snapshot covers.
- **The integration tier, re-run as is:** `integ` local (the runtime, capability composition and the Temporal worker against the real image) and `integ` aws (the AgentCore fixture on the new pin; `filesystem-s3-sync` with `s7cmd` on Debian).
- **e2e:**
  - `smoke-coverage` locally and on AgentCore: the `Python` procedure, plus everything it already covers, on the new base;
  - `golden-kata` locally and on AgentCore;
  - `golden-kata-workflows` locally, for the worker's dependency stage.
- **Settled once, no test:** which wheels NautilusTrader publishes, and what Debian ships. The e2e's `--only-binary` build fails loudly if the wheel set ever drifts.

## Risks / Trade-offs

- [The image grows: Debian slim is larger than Alpine] → It is measured when implemented and recorded in the commit. The size buys every glibc-only binary.
- [`--no-install-recommends` leaves out something git or the CLI relies on] → Every e2e exercises git-free runs and Bash runs; a missing dependency fails loudly there.
- [A detached Dockerfile stops receiving AgentForge's updates] → It is documented as the consumer's to keep. Sync still names a detached file only by its detachment, and the maintained lines are few.
- [A larger `smoke-coverage` image slows its deploy] → Accepted. The layer is cached locally, and ECR pushes only changed layers.
