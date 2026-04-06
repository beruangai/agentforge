# Testing Rules

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
- `project.json` test target uses `configurations.integ.configFile` pointing to `vitest.integ.mts`
## No Skip Guards in Integration Tests

Since integration tests are isolated in `integ/` with their own vitest config and Nx configuration, do NOT use `describe.skipIf(!process.env.INTEGRATION)` or similar environment variable guards. Integration tests should fail if the required environment (Docker, Temporal, etc.) is not available — this is the correct behavior. The isolation via separate config and `--configuration=integ` is the guard.

## Test Fixtures

Test fixtures (mock servers, test workflows, shared helpers) go in:
- `integ/__fixtures__/` for integration test fixtures
- `src/__fixtures__/` for unit test fixtures (if needed)