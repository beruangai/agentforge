# Proposal

## Why

A consumer extends the AgentForge image with what its procedures need (§REQ704). The image's base is Alpine, which uses musl, while most prebuilt native libraries are published for glibc. NautilusTrader 1.231.0 publishes only `manylinux_2_35` Linux wheels, for aarch64 and x86_64, so on Alpine a consumer's Python layer would build it from source — a Rust and Cython toolchain on every image build, on ARM64. StrategyFoundry's agents need Python and NautilusTrader, which makes this the one thing in A6 that blocks it from adopting. Nothing has yet proved that §REQ704 holds for a layer beyond what a package manifest can say.

## What Changes

- **The AgentForge image is built on Debian.** It uses `oven/bun:1.4.0-slim` (Debian 13, glibc 2.41), pinned by digest, in place of `oven/bun:1.4.0-alpine`.
  - It keeps what it has today: the collector, `s7cmd` (a static binary, unchanged), bash, git, ripgrep, CA certificates, the non-root `bun` user (uid 1000 in both images), and the container workspace.
  - Its packages come from `apt` instead of `apk`.
- **The worker image's dependency stage uses the same pin.** It installs the worker's native Temporal packages on Debian, matching the Node image they run on. Today they are installed on musl and run on glibc.
- **A layer extending its image beyond its manifest is proven on `smoke-coverage`.**
  - Its base layer's Dockerfile is detached, and adds Python and NautilusTrader from the prebuilt wheel only. A wheel missing for the platform fails the build rather than compiling from source.
  - The base layer is the place to do it: Python is shared by every agent in a project.
  - A new `hello-agent` procedure has its agent run Python, importing NautilusTrader, and answer with its version. This is verified locally and on AgentCore (ARM64).
  - The plugin's documentation says how a layer installs system packages: detach the layer's Dockerfile, install as `root`, and return to `bun`.
- **Proposed ADR 0018:** the AgentForge image is Debian, for glibc.
- **BREAKING** for a consumer that detached a Dockerfile and calls `apk`. There is none; no consumer is live.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plugin-agentic-project`: a layer can extend its image with system packages and with native libraries published only for glibc, installed prebuilt, while the image keeps running as a non-root user.

## Impact

- **Image:** `libs/agentforge/Dockerfile` changes its base and its package install. The worker's Dockerfile template changes its dependency stage's pin, along with its generated copy in `golden-kata-workflows`.
- **Examples:**
  - `smoke-coverage` detaches its base Dockerfile and gains a procedure.
  - Every example image rebuilds.
- **Verification:**
  - every tier that runs the image: `integ` local and aws, whose AgentCore fixture reads the pinned image;
  - both examples' e2e and e2e-agentcore;
  - `golden-kata-workflows`' e2e for the worker.
- **No change** to any protocol, the contract, the client, the runtime's or the harness's code, or the constructs.
- **Requirements:**
  - serves §REQ704;
  - keeps §REQ701: the same image locally and in the cloud;
  - keeps §REQ705.
- **Open options:** none depended on.

## Non-goals

- A plugin seam for system packages other than detaching: a scaffolded install script or a Dockerfile fragment. Detaching is the documented route, and a second one waits until a second consumer shows it is needed.
- Python, or anything StrategyFoundry needs, in the AgentForge image itself. It is the consumer's layer (§REQ704).
- Shrinking the image, or a distroless base.
- An x86_64 image. AgentCore runs ARM64 only.
