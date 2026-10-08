# Proposal

## Why

AgentForge's records say a consumer develops against it, until it is published (A8), by linking it with `bun link`. That does not work. Spiked on 2026-10-08 on Bun 1.4.0 and Node 26:
- A symlinked bundle resolves its peers from its real path under `dist/`, so zod is not found. Where a peer is reachable from there, AgentForge's own copy is used, so the consumer and AgentForge hold two instances of Zod, oRPC or aws-cdk-lib.
- `bun link`, and a `file:` directory dependency, which Bun installs as a folder of per-file symlinks, both fail this way.
- A tarball packed from the bundle and installed with `bun add <tarball>` is real files. Its peers resolve from the consumer, with one Zod instance under both runtimes, and a re-pack is picked up by `bun add` again.

Nothing has yet exercised the package as installed. The examples resolve it from source through the `@beruangai/source` condition, so the bundle's compiled plugin and the image build from an installed package have never run in another workspace. StrategyFoundry's scaffolding (A7) is the first to rely on both.

## What Changes

- **A `pack` target** on `@beruangai/agentforge`, depending on `bundle`. It packs the bundle into one tarball at a fixed path, `dist/libs/agentforge/pack/beruangai-agentforge.tgz`. That is exactly what publishing would ship.
- **Adopting before publication is installing that tarball.** A consumer's root `package.json` depends on `@beruangai/agentforge` by the tarball's **absolute path**, then runs the plugin's `init`, as `nx add` would. Generated manifests repeat the root's specifier, as they do today, so an absolute path resolves from every one of them. A relative path is not supported: the operator's choice for now, recorded as a limit.
- **Taking a newer AgentForge before publication:** `pack` in AgentForge, then `bun add` of the same path in the consumer, then `nx sync`.
- **A dogfood integration test, `integ/local/package-tarball/`.** It creates a workspace outside this repository with `@aws/nx-plugin`'s preset and installs the tarball. Then it generates an agentic project with an agent, and a workflow project connected to it. It builds the agent's images and the worker's bundle, typechecks, and checks sync. It is the first test of the package as installed.
- **Records corrected from `bun link` to the tarball:**
  - ROADMAP A7;
  - the root README's plugin section;
  - the package README's adoption;
  - the skill's Adopt row;
  - StrategyFoundry's `docs/AGENTFORGE_CORRECTIONS.md` §1 and §11.

  The spike becomes a dated research note.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plugin-agentic-project`: adds how a workspace adopts AgentForge before it is published, from a packed tarball of the published package, with its peers resolved from the workspace and its specifier repeated in what the plugin generates.

## Impact

- **`libs/agentforge/project.json`:** a `pack` target. No source, export or bundle change.
- **Tests:** `libs/agentforge/integ/local/package-tarball/`. It needs Docker and the network, for the preset and the images.
- **Docs:**
  - the root README and the package README: adopting and upgrading before publication;
  - ARCHITECTURE §8: the `pack` target;
  - ROADMAP A7;
  - the skill's `SKILL.md`;
  - `docs/research/`: the install spike.
- **StrategyFoundry:** its corrections doc, §1 and §11, the only edit there.
- **Requirements:** serves §REQ709, since a consumer adopts AgentForge and takes new versions without wiring by hand, now before publication too. Leaves none unmet. Publishing stays A8.
- **Open options:** none.

## Non-goals

- Publishing, a registry or prerelease versions. That is A8.
- A relative tarball path, or rewriting a path specifier per generated manifest.
- A live link that picks up source edits without packing. Matching the published package is the point.
- Serving or calling the generated agent in the dogfood test. The examples' e2e covers the path from a caller to a model. This test covers the installed package.
