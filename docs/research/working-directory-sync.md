# Working-directory sync — does `s7cmd` hold up?

**Measured on 2026-09-22.** `s7cmd` **1.8.3**, released 2026-09-19. Answers the mechanical half of [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §F — whether the leading implementation candidate does what the design note assumes. Source: `spikes/sync/f1-s7cmd-semantics.sh`.

§F rests three design choices on this tool: that `LastModifiedDate` filtering is a usable **quiescence heuristic**, that exclusions work, and that **delete propagation is an explicit choice rather than a default**. All three were assumptions. All three hold.

## It runs in the base image, and it is static

The risk the note did not name is **musl**: the AgentForge base is Alpine, and a Rust binary built against glibc would not run in it.

| | |
|---|---|
| asset | `s7cmd-1.8.3-linux-musl-aarch64.tar.gz` — **a musl aarch64 build is published** |
| in `oven/bun:1.4.0-alpine`, `linux/arm64` | `s7cmd 1.8.3 (aarch64-unknown-linux-musl)` — runs |
| linkage | **statically linked** (`ldd`: "Not a valid dynamic program") — no runtime dependency to install |
| binary | 12.7 MB |
| pinning | the release publishes a `.sha256`, and the downloaded archive **matched it** — `1ffd41f6…5056348` |

So the base image can install it with a verified digest and no package manager, which is what "pin it by digest" in §F needs to be actionable.

## Every behavioural claim holds

Eight checks against a real bucket, over a working directory shaped like an agent's — source, a `node_modules` tree, a `.git` directory, and one file still being written:

| Claim | Result |
|---|---|
| local → S3 upload | all five files |
| **quiescence**: `--filter-mtime-before <cutoff>` leaves a file touched moments ago | **the fresh file was skipped; the four settled ones uploaded** |
| exclusions: `--filter-exclude-regex '(^\|/)(\.git\|node_modules)/'` | `.git` and `node_modules` kept out, the rest uploaded |
| **delete propagation is OFF by default** | a file deleted locally **survived** in S3 |
| `--delete` | removed it |
| `--dry-run` | uploaded nothing |
| S3 → local round trip | came back intact |
| `--additional-checksum-algorithm SHA256` | accepted |

**The quiescence result is the one that matters**, because §F's "a file mid-write is left for the next pass" depends on it and nothing else in the tool offers it. `--filter-mtime-before` takes an **absolute timestamp**, so a caller computes the cutoff — `now − threshold` — on every pass rather than declaring a duration once. That is a small implementation detail with a real consequence: the threshold lives in the sync runner, not in the tool's configuration.

> One caveat on the method. On the first run the exclusions check **passed falsely**: `aws … --output text` prints the literal `None` for an empty result, and the catch-all arm accepted it, so "nothing was uploaded" read as "the right things were uploaded". The harness now filters `None`, and the re-run shows the real result. Recorded because the same shape of bug — a permissive default arm swallowing an empty result — would pass a green test suite just as easily.

## What this does not settle

**The tool does not constrain the declaration**, so every open question in §F stays open and stays a design decision: direction and what wins a conflict, whether delete propagation is offered at all, cadence and the quiescence threshold, whether AgentForge ships a starting exclusion list, and how a partial override reads. `s7cmd` can express all of them; which ones AgentForge *offers* is not a question a spike answers.

The standing reservation also stands: this is a personal project whose dependencies are updated best-effort, shipped in our base image and running with credentials. Pinning by the published sha256 is verified to work, and the AWS-SDK walk remains the fallback if that risk stops being acceptable.
