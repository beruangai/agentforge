# Tasks

Group 1 moves the base. Group 2 proves the extension on `smoke-coverage` and needs group 1. Group 3 verifies everything that runs the image. Group 4 closes the records.

## 1. The Debian base

- [ ] 1.1 `libs/agentforge/Dockerfile` is `FROM oven/bun:1.4.0-slim`, pinned by its index digest as resolved then, with `apt-get install --no-install-recommends bash git ca-certificates ripgrep`, and its comments are updated; the `s7cmd` stage takes the same pin. Verified by:
  - `nx run @beruangai/agentforge:image` on `linux/arm64`;
  - inside the built image: `id` is `bun` (uid 1000), and `bash`, `git`, `rg`, `s7cmd --version` and `aws-otel-collector --version` run;
  - the image's size against the Alpine one, for the commit message.
- [ ] 1.2 The worker template's `BUN_IMAGE` (`src/plugin/artifacts/workflow-project.ts`) takes the slim pin. `nx sync` regenerates `golden-kata-workflows/container/Dockerfile`. Verified by `nx run @beruangai/agentforge:test` (the generator's snapshot, updated) and `nx sync:check`.

## 2. Extending a layer

- [ ] 2.1 `smoke-coverage` detaches `base/Dockerfile` in its `project.json`, which installs Python 3 in a venv at `/opt/python` and `nautilus_trader==1.231.0` with `--only-binary=:all:`, as root before the layer's own files, then returns to `bun` with the venv on `PATH`. Verified by `nx sync:check` passing with the detachment, and by `nx run @beruangai/smoke-coverage:image` building on `linux/arm64`.
- [ ] 2.2 `hello-agent` gains `Python` (`{}` in, `{ version }` out): its agent runs Python importing NautilusTrader with `Bash(python *)` and answers with the version. Both e2e suites assert `1.231.0`. Verified by `nx run @beruangai/smoke-coverage:e2e`, and by `nx run @beruangai/smoke-coverage:e2e-agentcore` after its deploy.

## 3. Everything on the new base

- [ ] 3.1 Re-run every tier that runs the image, unchanged:
  - `nx run @beruangai/agentforge:integ --configuration=local`;
  - `nx run @beruangai/agentforge:integ --configuration=aws` (the AgentCore fixture on the new pin, and `filesystem-s3-sync`);
  - `nx run @beruangai/golden-kata:e2e` and `:e2e-agentcore`;
  - `nx run @beruangai/golden-kata-workflows:e2e`.

  Verified by each passing.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §7:** the AgentForge image's row names Debian slim and `apt`;
  - **the package README's plugin section:** how a layer adds system packages — detach its Dockerfile, install as `root`, return to `bun`, before the layer's own files;
  - **`docs/research/working-directory-sync.md`:** a dated note that the base is now Debian, and the musl `s7cmd` still runs as a static binary;
  - **ADR 0015:** unchanged, since its pin still holds;
  - **ADR 0018:** raised with the operator for acceptance;
  - **`smoke-coverage`'s README:** the `Python` procedure and the detached base Dockerfile.
