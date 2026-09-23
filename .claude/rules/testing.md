# Testing Rules

## Three tiers

Unit tests run against nothing external. **Runtime integration tests** run against a real AgentCore runtime with the model call stubbed inside the kernel — deterministic and cheap, covering admission, idempotency, the task-process protocol, cancellation, the lease, loss and deployment. **End-to-end tests** call a real model and cover structured output, settlement, in-turn correction and usage; they run after a change that could move them, not on every commit.

**A spike earns an integration test when its answer can drift.** Not every spike does. Ask what the answer depends on:

- **It depends on a platform or dependency that moves** — an SDK's behaviour, AgentCore's contract, what a registry serves. Write it as an integration test in `integ/`, because the answer is not self-renewing and a later version can quietly change it.
- **It settles a decision once** — which of three authoring styles, whether a tool runs on this architecture. A grounded ADR or research note stating the finding and its date is enough. A test that can only pass adds maintenance, not information.

The question is *would we want to be told when this changes*, not *did a spike produce it*.

Each tier is its own target and its own vitest config, so the guard is the target rather than a conditional inside a test. All three use the `@nx/vitest:test` executor; the `@nx/vitest` inference plugin is not registered, so no `test-ci` or per-file targets appear:

```json
"test":  { "executor": "@nx/vitest:test",
           "inputs": ["{projectRoot}/src/**/*", "{projectRoot}/vitest.config.mts", "..."],
           "outputs": ["{workspaceRoot}/dist/{projectRoot}/coverage"],
           "options": { "configFile": "{projectRoot}/vitest.config.mts" } },
"integ": { "executor": "@nx/vitest:test", "cache": false,
           "options": { "configFile": "{projectRoot}/vitest.integ.mts" } },
"e2e":   { "executor": "@nx/vitest:test", "cache": false,
           "options": { "configFile": "{projectRoot}/vitest.e2e.mts" } }
```

**`cache: false` on `integ` and `e2e` is load-bearing.** `nx.json` gives every `@nx/vitest:test` target `cache: true`, and a platform's or a model's behaviour is not an input Nx can hash — so a cached green run would be replayed without ever reaching AgentCore, S3 or the model, which is a silent pass. Run a subset with `--testFiles=integ/<concept>` or `-- -t <name>`.

The integ and e2e configs include only their own directory, and run sequentially with long timeouts because they shell out to containers and the platform:

```ts
test: {
  include: ['integ/**/*.{test,spec}.ts'],
  fileParallelism: false,
  sequence: { concurrent: false },
  testTimeout: 120_000,
  hookTimeout: 120_000,
}
```

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
- `project.json` has a separate `integ` target whose `configFile` is `vitest.integ.mts` (and `e2e` likewise), never a configuration of `test`
- Integ and e2e configs spread the unit config rather than `mergeConfig` it: `mergeConfig` concatenates arrays, so `include` would pick up the unit tests too
## No Skip Guards in Integration Tests

Since integration tests are isolated in `integ/` with their own vitest config and Nx configuration, do NOT use `describe.skipIf(!process.env.INTEGRATION)` or similar environment variable guards. Integration tests should fail if the required environment (Docker, Temporal, etc.) is not available — this is the correct behavior. The isolation via separate config and `--configuration=integ` is the guard.

## Test Fixtures

Test fixtures (mock servers, test workflows, shared helpers) go in:
- `integ/__fixtures__/` for integration test fixtures
- `src/__fixtures__/` for unit test fixtures (if needed)