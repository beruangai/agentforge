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
  - ADR 0008 puts "language runtimes a group of agents share" in a project's base layer. ADR 0010 says an agent adding Python and NautilusTrader belongs in a project of its own whose base extends the AgentForge image (§REQ704).
- **The worker image** (`workflow-project.ts`, `workerDockerfile`): its dependency stage is `FROM` the same Alpine pin and runs `bun install`; its runtime stage is `node:…-slim`, which is Debian. The installed `node_modules`, including the Temporal core's native bridge, are copied from musl to glibc.
- **The SDK's native CLI**: `@anthropic-ai/claude-agent-sdk` lists both `linux-arm64` and `linux-arm64-musl` packages, and picks between them at run time. The lock already holds both.
- **Observed 2026-10-08:**
  - **NautilusTrader 1.231.0 on PyPI** publishes:
    - `manylinux_2_35_aarch64` and `manylinux_2_35_x86_64` wheels for CPython 3.12–3.14;
    - macOS and Windows wheels;
    - an sdist;
    - no musllinux wheel.
  - **`oven/bun:1.4.0-slim`** is Debian 13 (trixie) for `arm64` and `amd64`. It creates the `bun` user and group at uid and gid 1000, as the Alpine image does. Debian 13 ships glibc 2.41 and Python 3.13.
  - The PyPI fact is dated in ADR 0018; the Debian facts go in `docs/research/working-directory-sync.md` (task 4.1), beside the musl note they replace.
- **Where the image is exercised:**
  - `integ` aws builds the AgentForge image (`integ/aws/__fixtures__/agentforge-base-image.ts`) and the AgentCore fixture on its Bun pin;
  - `integ` local runs the server in-process and never touches an image;
  - `golden-kata-workflows:e2e` runs the worker on the host from its `bundle`; only `golden-kata-workflows:e2e-agentcore`, which deploys `golden-kata-infra`, builds the worker's `container/Dockerfile`.

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

`-slim` rather than `-debian`, because it carries nothing AgentForge or a run uses beyond what is listed. The `s7cmd` stage moves to the same pin, and `tar` is in Debian's base. `s7cmd` stays the static musl build: a static binary runs on either C library, and it is the build `integ/aws/filesystem-s3-sync` verified, so ADR 0015's pin holds unchanged.

The distribution, and the options rejected for it, are [ADR 0018](../../../adr/0018-the-agentforge-image-is-debian.md), proposed.

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
 && apt-get install --yes --no-install-recommends python3 python3-venv libpython3.13 \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/python \
 && /opt/python/bin/pip install --no-cache-dir --only-binary=:all: nautilus_trader==1.231.0
USER bun
ENV PATH=/opt/python/bin:${PATH}
COPY …   # the maintained lines, unchanged
```

- `--only-binary=:all:` makes a missing wheel fail the build, so the proof can never pass by building from source.
- The venv sidesteps Debian's externally managed system Python (PEP 668).
- `libpython3.13`: NautilusTrader's Rust extension links `libpython3.13.so.1.0`, which Debian's `python3` does not install (observed 2026-10-08: without it, the import fails).
- `ENV PATH` reaches the server, every task process and the CLI's Bash tool, which inherit the image's environment.

The base layer is the place for it because ADR 0008 puts the language runtimes a project's agents share there; `smoke-coverage` has one agent, so ADR 0010's project of its own for such an agent is met as it stands. An agent layer that alone needs a package detaches its own Dockerfile the same way.

The image stays non-root by the route, not by a check: a detached Dockerfile is the consumer's, and AgentForge neither writes nor inspects its last `USER`. The documentation gives the route, and `smoke-coverage` proves it.

*Alternative:* a plugin seam that keeps the Dockerfile maintained, such as a scaffolded install script the maintained file runs as root. It would keep AgentForge's updates flowing into the file, but it is a second route for a need with one consumer, and Docker has no include. If StrategyFoundry's detached file drifts painfully from what sync would write, that is the evidence for it.

### `hello-agent`'s `ReportNautilusTraderVersion` procedure

```ts
// agents/hello-agent/agent/contract.ts — strict from the start, as `strict-contracts` requires
ReportNautilusTraderVersion: oc
  .input(z.strictObject({}))
  .output(z.strictObject({ version: z.string() })),
```

- **The run:** its agent runs Python importing NautilusTrader with Bash and answers with the version it printed — `python report_nautilus_trader_version.py`, a script in the agent's layer, since under the read fence the CLI cannot trace inline code (`python -c`) and denies it in `dontAsk`, an allow rule notwithstanding (observed in the joint verification, 2026-10-08; `docs/research/claude-agent-sdk.md`). It has `tools: ['Bash']` and `allowedTools: ['Bash(python *)', 'Bash(python3 *)']` — the venv provides both names, and the model may pick either — in `dontAsk`, over the base options.
- **The e2e:** it asserts the version is `1.231.0`, locally and on AgentCore.

A procedure always runs an agent (REQUIREMENTS: settled), and an agent running Python through Bash is exactly the use the image serves. The fence does not bound Bash that is not read-only, which is already a known limit and unchanged.

*Where:* `smoke-coverage` rather than `golden-kata` or a new example. It holds what AgentForge does around a run, and a third project would add another deployment for one procedure. The cost is a larger `smoke-coverage` base image; the Python layer is cached ahead of the layer's own files.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| No wheel for the platform | building the base layer's image | the build fails, naming the package; nothing is compiled |
| A Debian package missing | building the AgentForge image | the build fails |
| Python or the library missing at run time | the agent's Bash call | the agent cannot answer the version; the e2e fails on its answer |
| The image running as root | — | every Dockerfile AgentForge maintains ends on `USER bun`; a detached one is the consumer's, and the CLI refuses unattended tools as root |

## What earns which test

- **No new unit test.** Nothing in the package's TypeScript changes, except the worker template's pin, which its snapshot covers.
- **Inside the built images** (tasks 1.1 and 2.1): the tools run, and `id -u` is `1000` in the AgentForge image and in the extended `smoke-coverage` image.
- **The integration tier:** `integ` aws — the AgentCore fixture on the new pin, and `filesystem-s3-sync` with `s7cmd` in the Debian image. `integ` local touches no image and is not evidence here.
- **e2e, in the batch's joint verification** (`task-image`'s last group):
  - `smoke-coverage` locally and on AgentCore: `ReportNautilusTraderVersion`, plus everything it already covers, on the new base;
  - `golden-kata` locally and on AgentCore;
  - `golden-kata-workflows:e2e-agentcore`, which builds and deploys the worker's image with its new dependency stage.
- **Settled once, no test:** which wheels NautilusTrader publishes, and what Debian ships. The e2e's `--only-binary` build fails loudly if the wheel set ever drifts.

## Risks / Trade-offs

- [The image grows: Debian slim is larger than Alpine] → It is measured when implemented and recorded in the commit. The size buys every glibc-only binary.
- [`--no-install-recommends` leaves out something git or the CLI relies on] → Every e2e exercises git-free runs and Bash runs; a missing dependency fails loudly there.
- [A detached Dockerfile stops receiving AgentForge's updates] → It is documented as the consumer's to keep. Sync still names a detached file only by its detachment, and the maintained lines are few.
- [A larger `smoke-coverage` image slows its deploy] → Accepted. The layer is cached locally, and ECR pushes only changed layers.
