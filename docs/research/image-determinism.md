# Deterministic image builds — spike findings

**Measured on 2026-09-22.** Docker 29.4.1 with BuildKit v0.29.0, buildx v0.33.0, Docker Desktop on macOS arm64, `linux/arm64` targets, base pinned to `oven/bun@sha256:0723…437eb`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §D's central question. No model spend, no AWS.

Source: `spikes/images/` — `setup.sh`, the three-level image tree, and `d1-deterministic-builds.sh`.

---

## The verdict

[ADR 0008](../../adr/0008-code-ships-in-the-image.md) holds. All three properties it depends on were observed, on manifest digests, with a real three-level layering.

| | Result |
|---|---|
| An unchanged rebuild is byte-identical | **yes** — all five digests identical across two full rebuilds |
| A change to one agent does not spread | **yes** — `agent-a` moved; `agent-b`, `agent-c` and the agentic base all identical |
| A change to the agentic base moves every agent above it, and nothing below | **yes** — agentic base and all three agents moved; the AgentForge base image identical |

```
                        build 1            build 2 (no change)   agent-a changed      agentic base changed
base (agentforge)       dc80e4b618bbfabc   dc80e4b618bbfabc  ✓   dc80e4b618bbfabc ✓   dc80e4b618bbfabc ✓
agentic base            87144958b80d4d74   87144958b80d4d74  ✓   87144958b80d4d74 ✓   33e406bf35d113b8 →
agent-a                 6f42a25e3213b6e1   6f42a25e3213b6e1  ✓   280e6f9185fc00fa →   2b2cb84a94b18bad →
agent-b                 1504d72d799ede84   1504d72d799ede84  ✓   1504d72d799ede84 ✓   5653948909b23dbc →
agent-c                 f3c0f73c6111e407   f3c0f73c6111e407  ✓   f3c0f73c6111e407 ✓   d6b167a2cc8ae84d →
```

**So `UpdateAgentRuntime` can be driven by digest comparison**, and an unaffected agent is genuinely never given a new version. Nx's affected graph decides what to rebuild; the digest decides what to deploy, exactly as `ARCHITECTURE.md` §6 says.

## What determinism actually requires

Three builds of the same context, `--no-cache`, two seconds apart:

| Switches | Digest across two builds |
|---|---|
| `SOURCE_DATE_EPOCH` **and** `rewrite-timestamp=true` | **IDENTICAL** |
| `SOURCE_DATE_EPOCH` alone | **MOVED** |
| neither | **MOVED** |

**`rewrite-timestamp` is the load-bearing one, and `SOURCE_DATE_EPOCH` alone is a trap** — it normalises the image config's `created` field but leaves file mtimes in the layer tarballs, so the layer digests move and so does the manifest. A build pipeline that sets only `SOURCE_DATE_EPOCH` looks reproducible in its configuration and is not.

Both are needed: `rewrite-timestamp` rewrites timestamps *to* `SOURCE_DATE_EPOCH`, so it has nothing to rewrite to without it.

Also required, and all three already in `ARCHITECTURE.md` §6:

- **`--provenance=false`.** Provenance attestations embed build metadata and make the manifest an index whose digest moves per build.
- **The parent pinned by digest at every level.** Each stage's `FROM` takes `<registry>/<repository>@sha256:…`, not a tag. A moving tag makes every image above it move.
- **No unpinned package installs.** No `apk upgrade`, no unpinned index: the fixtures deliberately have none, and a real base image that adds one loses the property silently.

## Three obstacles worth knowing before writing the deploy path

None of these is exotic; all three cost time and none is in the obvious documentation.

**1. The `docker` driver cannot export OCI at all.**

```
ERROR: failed to build: OCI exporter is not supported for the docker driver.
```

A `docker-container` builder is required for anything that needs the artifact a registry would receive.

**2. The `docker` exporter does not rewrite layer timestamps**, so the image id it reports is *not* a determinism signal. Two `--no-cache` builds of an identical context under `SOURCE_DATE_EPOCH`:

```
sha256:4110f68c6b8e2007b57cc28c6c6683ef8bbf21e4eca30ae1c022d5c4db999fbc
sha256:d4637161a29b210e36af6a37a51ca39e8a7007f1769ec8a76028f11f76d21607
```

A pipeline that compares `docker image inspect --format '{{.Id}}'` will conclude every image changed, every time, and redeploy everything. **The comparison must be on the manifest digest**, which buildx reports as `containerimage.digest` in `--metadata-file` — authoritative, and free.

**3. A `docker-container` builder cannot see images in the daemon.** A multi-level `FROM` chain therefore needs a registry between the levels; `--load`ing a parent and referencing it by tag fails to resolve. This is not a workaround so much as the real shape: in production each level *is* pushed to ECR and referenced by digest, so the spike models the deploy path rather than shortcutting it. A throwaway `registry:2` on `host.docker.internal:5001` served, with a two-line buildkitd config trusting it over http.

### And one that is environmental, not architectural

On macOS, Docker's keychain credential helper blocks without an interactive unlock, and every pull then fails as `error getting credentials - err: signal: terminated`, which reads like a network fault. `setup.sh` writes a `DOCKER_CONFIG` with `credsStore` removed. Worth recording only because it burned time and will do so again on any developer machine.

---

## What this does not answer

§D asks more than the layering question, and the rest is untouched:

- **Bun's bundler determinism.** The fixtures copy plain files; nothing was bundled. Whether `bun build` emits byte-identical output across runs — module ordering, hashed chunk names, embedded paths — is a separate measurement and is the likelier source of non-determinism in a real agent image than anything Docker does.
- **Comparing digests before `UpdateAgentRuntime`.** The digest is available and stable; the deploy path that reads the current runtime's digest and skips the update is not written.
- **Task-protocol version negotiation** between an executor and a task process built from different artifacts — how long an executor supports an older task process.
- **Whether the agent card is generated as a build step** from the image's own registry of procedures.
- **Where `agentforge/a2a-claude` is published**, how a consumer pins it, and whether the constructs assert a compatible package-and-image pairing at deploy.

## Teardown

`spikes/images/teardown.sh` removes the throwaway registry container, the buildx builder and the spike images. Nothing was created in AWS for this spike.

---

## `bun build` is deterministic — measured 2026-09-22

The section above measured determinism over fixtures that **copy plain files**. Nothing was bundled, and bundling was named as the likelier source of non-determinism in a real agent image: module ordering, chunk hashing and embedded absolute paths are all things a bundler can vary between runs.

Measured on **Bun 1.4.0** against a real 2.26 MB bundle — the AgentCore spike server with Express, `@a2a-js/sdk` and two AWS SDK clients (`spikes/bundler/d2-bun-bundler-determinism.sh`):

| Variation | Result |
|---|---|
| same input, same directory, twice | **byte-identical** |
| same input, built from a **different absolute path** | **byte-identical** — no build path is embedded |
| same input, **every source mtime changed** | **byte-identical** — the bundler does not read file times |
| `--minify`, twice | **byte-identical** |
| **negative control:** one line added to a source file | **digest moved** |

The negative control is the point: four passes prove nothing unless the comparison can fail, and it does.

**So the bundler is not a source of image drift.** Determinism for an agent image rests entirely on the Docker-level requirements above — `SOURCE_DATE_EPOCH` *and* `rewrite-timestamp=true`, `--provenance=false`, parents pinned by digest, no unpinned package installs — and nothing needs to be done about `bun build` itself.
