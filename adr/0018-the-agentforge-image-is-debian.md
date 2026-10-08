---
status: proposed
date: 2026-10-08
decision-makers: Jeremy Jonas
---

# The AgentForge image is Debian, for glibc

## Context and Problem Statement

Every agent image is built on the AgentForge image, and a consumer extends it with what its procedures need (§REQ704). Which distribution should the AgentForge image use? Prebuilt native libraries are mostly published for glibc: NautilusTrader 1.231.0, which StrategyFoundry's agents need, publishes only `manylinux_2_35` wheels for Linux and no musl wheel (PyPI, 2026-10-08). The image was Alpine, which uses musl.

## Considered Options

* **Alpine**, with a consumer building glibc-only libraries from source
* **Alpine with `gcompat`**, a partial glibc compatibility shim
* **Debian slim** (`oven/bun:<version>-slim`), glibc

## Decision Outcome

Chosen option: **Debian slim.** The Bun image's own Debian variant is pinned by digest, as the Alpine one was. It provides the same `bun` user at uid 1000, and installs bash, git, ca-certificates and ripgrep with `apt`. Static binaries the image copies in — the collector and `s7cmd` — are unaffected.

### Consequences

* Good, because a consumer's layer installs prebuilt glibc binaries and wheels as published, on ARM64, with no toolchain in its build
* Good, because the worker image installs its native packages on the C library it runs them on
* Bad, because the image is larger than Alpine's
* Neutral, because musl builds of anything AgentForge ships (`s7cmd`) still run: they are static

### Confirmation

`smoke-coverage`'s base layer installs NautilusTrader from its wheel only, refusing a source build, and its agent imports it, locally and on AgentCore.

## Pros and Cons of the Options

### Alpine, building from source

* Good, because the image is smallest
* Bad, because every glibc-only library is a source build in the consumer's image, with a Rust or C toolchain, repeated on every build

### Alpine with `gcompat`

* Bad, because it shims only part of glibc's ABI, and pip installs no `manylinux` wheel on musl
