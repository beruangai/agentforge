# Tasks

Group 0 opens the batch of four A6 changes. Group 1 moves the base. Group 2 proves the extension on `smoke-coverage` and needs group 1. Group 3 is this change's end-to-end proof, run in the batch's joint verification. Group 4 closes the records.

## 0. Before the batch

- [ ] 0.1 With the operator's approval for each, destroy the deployed example stacks — `nx run @beruangai/smoke-coverage-infra:destroy` and `nx run @beruangai/golden-kata-infra:destroy` — while their teardown scripts still match what is deployed. Verified by each destroy completing, and by its stack being gone from CloudFormation.

## 1. The Debian base

- [x] 1.1 `libs/agentforge/Dockerfile` is `FROM oven/bun:1.4.0-slim`, pinned by its index digest as resolved then, with `apt-get install --no-install-recommends bash git ca-certificates ripgrep`, and its comments are updated; the `s7cmd` stage takes the same pin. Verified by:
  - `nx run @beruangai/agentforge:image` on `linux/arm64`;
  - inside the built image: `id -u` is `1000` as `bun`, and `bash`, `git`, `rg`, `s7cmd --version` and `aws-otel-collector --version` run;
  - the image's size against the Alpine one, for the commit message.
- [x] 1.2 The worker template's `BUN_IMAGE` (`src/plugin/artifacts/workflow-project.ts`) takes the slim pin. `nx sync` regenerates `golden-kata-workflows/container/Dockerfile`. Verified by `nx run @beruangai/agentforge:test` (the generator's snapshot, updated) and `nx sync:check`.

## 2. Extending a layer

- [x] 2.1 `smoke-coverage` detaches `base/Dockerfile` in its `project.json`, which installs Python 3 (and `libpython3.13`) in a venv at `/opt/python` and `nautilus_trader==1.231.0` with `--only-binary=:all:`, as root before the layer's own files, then returns to `bun` with the venv on `PATH`. Verified by `nx sync:check` passing with the detachment, by `nx run @beruangai/smoke-coverage:image-hello-agent` building on `linux/arm64`, and, inside the agent image, by `id -u` being `1000` and `python -c "import nautilus_trader"` succeeding.
- [x] 2.2 `hello-agent` gains `ReportNautilusTraderVersion` (`z.strictObject({})` in, `z.strictObject({ version })` out): its agent runs Python importing NautilusTrader, with `Bash(python *)` and `Bash(python3 *)` allowed, and answers with the version. Both of `smoke-coverage`'s e2e suites assert `1.231.0`. Verified by `nx run-many -t typecheck lint` for `smoke-coverage`; its e2e runs in the batch's joint verification.

## 3. End to end, in the batch

- [ ] 3.1 Ticked when the batch's joint verification (`task-image`, group 5) passes the parts that prove this change:
  - `integ` aws: the AgentCore fixture on the new pin, and `filesystem-s3-sync`;
  - `smoke-coverage`'s `e2e` and `e2e-agentcore`, with `ReportNautilusTraderVersion`;
  - `golden-kata`'s `e2e` and `e2e-agentcore`;
  - `golden-kata-workflows:e2e-agentcore`, which builds and deploys the worker's image.

## 4. Records

- [x] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §7:** the AgentForge image's row names Debian slim and `apt`;
  - **the package README's plugin section:** how a layer adds system packages — detach its Dockerfile, install as `root` before the layer's own files, return to `bun` — and that staying non-root is then the consumer's;
  - **`docs/research/working-directory-sync.md`:** a dated note that the base is now Debian 13 (glibc 2.41, Python 3.13, `bun` at uid 1000), and that the musl `s7cmd` still runs as a static binary;
  - **`integ/aws/agentcore/README.md`:** the fixture builds "on the Bun image the base `Dockerfile` pins", no longer naming Alpine;
  - **ADR 0018:** raised with the operator for acceptance;
  - **ADR 0015:** unchanged, since its pin still holds;
  - **`smoke-coverage`'s README:** `ReportNautilusTraderVersion` and the detached base Dockerfile.
