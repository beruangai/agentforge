# Tasks: Claude Sandbox Package

## Phase 1: Core Container Lifecycle

- [x] Set up package dependencies (`dockerode`, `@anthropic-ai/claude-code`, `langsmith`, `zod`)
- [x] Implement `container-runtime.ts` — dockerode abstraction (create, start, wait, remove, inspect)
- [x] Implement sentinel I/O extraction (`sentinel.ts` — extract output between markers)
- [x] Implement `container-runner.ts` — full lifecycle (create → stdin → stdout → parse → cleanup)
- [x] Implement `SandboxRunner` class wrapping container-runner with config defaults
- [x] Write unit tests for sentinel extraction (valid, missing, malformed, noise)
- [x] Write unit tests for container-runner (mock dockerode)

## Phase 2: Identity & Sessions

- [x] Implement container identity (`container-identity.ts` — config hash naming)
- [x] Implement session management (`sessions.ts` — directory creation, .claude mount)
- [x] Integrate identity + sessions into SandboxRunner
- [x] Write unit tests for identity hashing (same config = same hash, different = different)
- [x] Write unit tests for session directory management

## Phase 3: Volume & Credential Management

- [x] Implement volume resolver (`volume-resolver.ts` — VolumeMap to Docker bind mounts)
- [x] Support readonly mounts (`{ target, readonly }` syntax)
- [x] Implement credential config (`credential-config.ts` — env mode)
- [x] Stub OneCLI mode (credential-config with proxy URL, defer full implementation)
- [x] Write unit tests for volume resolution
- [x] Write unit tests for credential config generation

## Phase 4: Agent Runner & Image Management

- [x] Implement agent-runner entry point (`agent-runner/index.ts`)
- [x] Implement sentinel output helpers (`agent-runner/output.ts`)
- [x] Implement LangSmith trace reconstruction (`agent-runner/tracing.ts`)
- [x] Create base Dockerfile (`docker/Dockerfile.base`)
- [x] Implement `ImageManager` — auto-build base image on first use, content-hash change detection
- [x] Support custom Dockerfile override via `SandboxRunnerConfig.dockerfile`
- [x] Ensure Dockerfile.base is included in npm package (`files` in package.json)
- [x] Verify Agent SDK `query()` API surface matches design types (adapt as needed)
- [x] Write agent-runner unit tests (mock Agent SDK `query()`)
- [x] Write unit tests for image manager (build trigger, hash check, custom dockerfile)

## Phase 5: Integration & Polish

- [x] Integration test: full lifecycle with real Docker (create → execute → sentinel → cleanup)
- [x] Integration test: volume mounting verification
- [x] Integration test: session persistence across executions
- [x] Integration test: timeout handling (container kill)
- [x] Integration test: error propagation (agent error → sentinel → host error)
- [x] Integration test: container can reach host via `host.docker.internal`
- [x] Export all public API from `index.ts`
- [x] Add JSDoc comments to public API
- [x] Verify build output (ESM, `.d.ts`)
- [x] Write package README with usage examples
