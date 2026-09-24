# Testing Rules

## Three tiers, and when each runs

| Target | What it is | When it runs | Credentials |
|---|---|---|---|
| `test` | Unit tests, colocated with their source, against nothing external | Every build — `build` depends on it | None |
| `integ` | **Live slices**: one thing AgentForge relies on, exercised against the real platform or dependency — AgentCore, S3, Docker, the Agent SDK against a model. From A1, also the runtime with the model call stubbed inside the kernel | **The gate before publishing, never on every commit** | Per configuration, below |
| `e2e` | **The whole path**: a caller, through the client and a runtime, to the harness, the SDK and a real model, and back as a typed outcome | Before publishing, once it exists — **from A1**, locally in Docker, then against a deployed agent at A2. No target until then | AWS and the model |

A live slice is integration, however expensive it is: calling a real model makes a test costly, not end-to-end.

**`integ` is grouped by what a test needs to run**, which is also what it costs: `integ/<dimension>/<concept>/`, each dimension a configuration of the target.

| Configuration | Folder | Needs | Costs |
|---|---|---|---|
| `local` | `integ/local/` | Docker and the local toolchain | Nothing |
| `aws` | `integ/aws/` | The test role in `us-east-2` | Short-lived AWS resources, minutes of wall clock |
| `model` | `integ/model/` | The subscription token | Model inference — money and latency |

`nx run @beruangai/agentforge:integ` runs everything; `--configuration=local` (or `aws`, `model`) runs one dimension. A concept goes in the folder of the most expensive thing it needs. A new dimension is a new folder, a new vitest project and a new configuration — never a conditional inside a test.

**The higher the tier, the more a test must earn its cost.** A model test spends money and minutes on every run, so each scenario must assert something AgentForge relies on and cannot learn more cheaply. A scenario whose outcome is the model's choice — whether it complies or argues, whether it reaches for a parameter — asserts only what holds either way, or it goes. Findings a dropped scenario produced stay in the research note with their date.

**A spike earns an integration test when its answer can drift.** Not every spike does. Ask what the answer depends on:

- **It depends on a platform or dependency that moves** — an SDK's behaviour, AgentCore's contract, what a registry serves. Write it as an integration test in `integ/`, because the answer is not self-renewing and a later version can quietly change it.
- **It settles a decision once** — which of three authoring styles, whether a tool runs on this architecture. A grounded ADR or research note stating the finding and its date is enough. A test that can only pass adds maintenance, not information.

The question is *would we want to be told when this changes*, not *did a spike produce it*.

**Test what AgentForge relies on and the platform does not guarantee.** A documented guarantee is trusted, not re-tested — that each AgentCore session gets its own microVM is AgentCore's promise, not a finding. An observation nothing depends on — a warm pool, a latency, an exact list of forwarded headers — is a dated research note, not an assertion. A test earns its place when all three hold: AgentForge's design rests on the answer, the documentation is silent, ambiguous or wrong about it, and the answer can move. Whether AgentForge passes an option through is its own unit test; whether the SDK then honours a documented option is the SDK's.

Each tier is its own target and its own vitest config, so the guard is the target rather than a conditional inside a test. They are `nx:run-commands` targets running `vitest run`: `@nx/vitest:test` is deprecated for Nx 24 and ignored a target's declared external inputs, and the inference plugin would add `test-ci` and per-file targets nobody runs:

```json
"test":  { "executor": "nx:run-commands", "cache": true,
           "inputs": ["{projectRoot}/src/**/*", "{projectRoot}/vitest.config.mts", "...",
                      { "runtime": "node --version" }, { "runtime": "bun --version" }],
           "outputs": ["{workspaceRoot}/dist/{projectRoot}/test"],
           "options": { "command": "vitest run --config vitest.config.mts", "cwd": "{projectRoot}" } },
"integ": { "executor": "nx:run-commands", "cache": false,
           "options": { "command": "vitest run --config vitest.integ.mts", "cwd": "{projectRoot}" },
           "configurations": { "local": { "args": "--project=@beruangai/agentforge:integ:local" },
                               "aws":   { "args": "--project=@beruangai/agentforge:integ:aws*" },
                               "model": { "args": "--project=@beruangai/agentforge:integ:model" } } }
```

**A cached target hashes every external dependency** — no `externalDependencies` list narrows it — so a bump of any package it could load re-runs it; a list that names only the obvious tool is how a cached green result survives a dependency change. A target that shells out to a runtime declares it as a `runtime` input.

**`cache: false` on `integ` is load-bearing** (and on `e2e` when it exists). A platform's or a model's behaviour is not an input Nx can hash, so a cached green run would be replayed without ever reaching AgentCore, S3 or the model, which is a silent pass. Run a subset by path or name after `--`: `nx run @beruangai/agentforge:integ -- integ/model/kernel-settlement/in-turn-correction` or `-- -t <name>`.

`vitest.integ.mts` has one vitest project per dimension, each including only its folder, running one file at a time with long timeouts because they shell out to containers and the platform:

```ts
{ test: { name: '@beruangai/agentforge:integ:local',
          include: ['integ/local/**/*.{test,spec}.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 120_000,
          hookTimeout: 120_000 } }
```

**The exception is a concept whose files own disjoint platform resources.** `integ/aws/agentcore/` runs its files in parallel as its own vitest project: each file provisions and deletes a uniquely named runtime, so no file can see another's, and deletion alone takes minutes. A new concept earns the same only when that holds; a shared runtime is not the way to go faster.

## Credentials per target

A target gets exactly the credentials it uses, from `.env.<target>` — never from `.env.local`, which Nx loads into every task. Nx loads `.env.<target>.<configuration>.local`, `.env.<target>.<configuration>`, then `.env.<target>.local`, then `.env.<target>`, then `.env.local`, then `.env`, and the first to set a variable wins.

- `integ`: `.env.integ` (committed) sets `AWS_PROFILE=agentforge--test-integ` and `AWS_REGION=us-east-2` — a test-only role in the AgentForge account, assumed from the operator's SSO session, in a region that is not prod's (`integ/aws/test-role-permissions-policy.json`). `.env.integ.local` (ignored) holds the subscription token for `integ/model/`
- `test`: nothing. There is no `default` profile, so a task with no `AWS_PROFILE` has no AWS credentials at all
- `e2e`, from A1, and a future `synth` or `deploy`, take theirs from `.env.e2e`, `.env.synth`, `.env.deploy` the same way

## No Placeholder Integration Tests

Never create placeholder or deferred integration tests with `expect(true).toBe(true)` or `// TODO: implement` stubs.
If Docker or other infrastructure is required, write the actual test with proper `describe.skipIf()` guards.
The test should be real and runnable when the prerequisite (Docker, Temporal, etc.) is available.

## Unit Test Colocation

Unit tests live next to their source files:
- `src/activity/error-classification.ts` → `src/activity/error-classification.test.ts`
- **Not** in a separate `src/__tests__/` directory

## Integration Test Isolation

Integration tests live in `{projectRoot}/integ/` with their own vitest config:

```
packages/my-package/
├── src/                          # Source + colocated unit tests
│   ├── foo.ts
│   └── foo.test.ts
├── integ/                        # Integration tests (Docker, network, Temporal)
│   ├── full-lifecycle.test.ts
│   └── workflow-environment.test.ts
├── vitest.config.mts             # Unit tests only (excludes integ/)
└── vitest.integ.mts              # Integration tests only (includes integ/**)
```

- Base `vitest.config.mts` excludes `integ/**`
- `vitest.integ.mts` extends base config, overrides `include` to `integ/**/*.{test,spec}.*`
- `project.json` has a separate `integ` target whose `configFile` is `vitest.integ.mts` (and `e2e` likewise, from A1), never a configuration of `test`
- The integ config spreads the unit config rather than `mergeConfig` it: `mergeConfig` concatenates arrays, so `include` would pick up the unit tests too
## No Skip Guards in Integration Tests

Since integration tests are isolated in `integ/` with their own vitest config and Nx configuration, do NOT use `describe.skipIf(!process.env.INTEGRATION)` or similar environment variable guards. Integration tests should fail if the required environment (Docker, Temporal, etc.) is not available — this is the correct behavior. The isolation via a separate target and config is the guard.

## Test Fixtures

Test fixtures (mock servers, test workflows, shared helpers) go in:
- `integ/__fixtures__/` for integration test fixtures
- `src/__fixtures__/` for unit test fixtures (if needed)