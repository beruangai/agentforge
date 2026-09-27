# Working-directory sync — does `s7cmd` hold up?

**Measured on 2026-09-22** with `s7cmd` **1.8.3**; **re-checked on 2026-09-27** with **1.8.5**, the release the base image pins, through `packages/agentforge/integ/aws/filesystem-s3-sync/`, which drives `S3Filesystem`'s own sync with `s7cmd` in the base image as built. Decided in [ADR 0015](../../adr/0015-filesystems-mount-around-a-procedure.md).

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

## What 1.8.5 showed on 2026-09-27

Through the harness's own arguments, against a scratch bucket in `us-east-2`:

- **Exclusions match paths relative to the prefix, in both directions**: an anchored `^cache/` kept `p/cache/…` out of a pull, and `--delete` left it in place.
- **`--check-etag` does not send an unchanged file again**: a pulled file the task left alone kept its `LastModified` across the push.
- **A key with a `..` segment stays out**: `p/../escape.md`, stored literally, was not written outside the directory — the harness excludes such paths itself, so this does not rest on the tool.
- **The quiet period holds** as `--filter-mtime-before`: a continuous push took the settled file and left the fresh one.
- **Exit codes**: a missing bucket exits non-zero (unsynced); an unparsable pattern exits 2.
- **Credentials**: the AWS SDK for Rust's default chain; inside AgentCore, proven by `hello-agent`'s e2e.

The standing reservation also stands: this is a personal project whose dependencies are updated best-effort, shipped in our base image and running with credentials. Pinning by the published sha256 is verified to work, and the AWS-SDK walk remains the fallback if that risk stops being acceptable.
