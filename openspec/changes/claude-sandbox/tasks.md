# Tasks: Claude Sandbox Package

## Phase 1: Core Container Lifecycle

- [ ] Set up package dependencies (`dockerode`, `@anthropic-ai/claude-code`, `langsmith`, `zod`)
- [ ] Implement `container-runtime.ts` — dockerode abstraction (create, start, wait, remove, inspect)
- [ ] Implement sentinel I/O extraction (`sentinel.ts` — extract output between markers)
- [ ] Implement `container-runner.ts` — full lifecycle (create → stdin → stdout → parse → cleanup)
- [ ] Implement `SandboxRunner` class wrapping container-runner with config defaults
- [ ] Write unit tests for sentinel extraction (valid, missing, malformed, noise)
- [ ] Write unit tests for container-runner (mock dockerode)

## Phase 2: Identity & Sessions

- [ ] Implement container identity (`container-identity.ts` — config hash naming)
- [ ] Implement session management (`sessions.ts` — directory creation, .claude mount)
- [ ] Integrate identity + sessions into SandboxRunner
- [ ] Write unit tests for identity hashing (same config = same hash, different = different)
- [ ] Write unit tests for session directory management

## Phase 3: Volume & Credential Management

- [ ] Implement volume resolver (`volume-resolver.ts` — VolumeMap to Docker bind mounts)
- [ ] Support readonly mounts (`{ target, readonly }` syntax)
- [ ] Implement credential config (`credential-config.ts` — env mode)
- [ ] Stub OneCLI mode (credential-config with proxy URL, defer full implementation)
- [ ] Write unit tests for volume resolution
- [ ] Write unit tests for credential config generation

## Phase 4: Agent Runner & Image Management

- [ ] Implement agent-runner entry point (`agent-runner/index.ts`)
- [ ] Implement sentinel output helpers (`agent-runner/output.ts`)
- [ ] Implement LangSmith trace reconstruction (`agent-runner/tracing.ts`)
- [ ] Create base Dockerfile (`docker/Dockerfile.base`)
- [ ] Implement `ImageManager` — auto-build base image on first use, content-hash change detection
- [ ] Support custom Dockerfile override via `SandboxRunnerConfig.dockerfile`
- [ ] Ensure Dockerfile.base is included in npm package (`files` in package.json)
- [ ] Verify Agent SDK `query()` API surface matches design types (adapt as needed)
- [ ] Write agent-runner unit tests (mock Agent SDK `query()`)
- [ ] Write unit tests for image manager (build trigger, hash check, custom dockerfile)

## Phase 5: Integration & Polish

- [ ] Integration test: full lifecycle with real Docker (create → execute → sentinel → cleanup)
- [ ] Integration test: volume mounting verification
- [ ] Integration test: session persistence across executions
- [ ] Integration test: timeout handling (container kill)
- [ ] Integration test: error propagation (agent error → sentinel → host error)
- [ ] Integration test: container can reach host via `host.docker.internal`
- [ ] Export all public API from `index.ts`
- [ ] Add JSDoc comments to public API
- [ ] Verify build output (ESM, `.d.ts`)
- [ ] Write package README with usage examples
