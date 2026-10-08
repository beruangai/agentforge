# Design

## Context

See proposal.md, Why. What holds today:

- **The published package is the `bundle` task's output**, `dist/libs/agentforge/bundle`. It contains:
  - the compiled entry points and plugin;
  - `generators.json` and `executors.json` naming the plugin's JavaScript;
  - the AgentForge image's `Dockerfile`;
  - `container/package.json` and `bun.lock`;
  - a manifest with no `@beruangai/source` condition.

  `publint --pack npm` already checks it. `libs/agentforge/package.json` is not installable: its `default` exports name files that exist only in the bundle.
- **The plugin tells source from installed in one place** (`container/container-inputs.ts`). From source, it reads the container inputs from the bundle output. Installed, it reads them from the package directory above the running code.
- **Generated manifests repeat the root's specifier** (`agentforgeSpecifier`, `workspace-dependencies.ts`). That is `workspace:*` here and a version in a consumer. An absolute path repeats correctly. A relative one would resolve against each manifest's own directory.
- **The spike, 2026-10-08, Bun 1.4.0, Node 26**, in a scratch consumer outside this repository:

  | Install | Peers resolve from | Result |
  |---|---|---|
  | `bun link` (a symlink to the bundle) | the bundle's real path under `dist/` | `Cannot find package 'zod'` |
  | `file:<bundle directory>` | the same: Bun installs a folder of per-file symlinks | the same |
  | `bun pm pack`, then `bun add <tarball>` | the consumer's `node_modules` | one Zod instance under Bun and Node |

- **A consumer workspace is `@aws/nx-plugin`'s preset**, created with `create-nx-workspace --preset=@aws/nx-plugin --pm=bun`, as this one was (`docs/research/aws-nx-plugin.md`).

## Goals / Non-Goals

**Goals:**
- One archive, built by Nx, that is exactly what publishing would ship.
- A consumer installs it, and everything the plugin does works as it would for a published version, verified from a workspace outside this repository.

**Non-Goals:** as in proposal.md.

## Decisions

### `pack` packs the bundle to a fixed path

```jsonc
// libs/agentforge/project.json
"pack": {
  "executor": "nx:run-commands",
  "cache": true,
  "dependsOn": ["bundle"],
  "inputs": ["production"],
  "outputs": ["{workspaceRoot}/dist/{projectRoot}/pack"],
  "options": {
    "cwd": "{workspaceRoot}/dist/{projectRoot}/bundle",
    "command": "mkdir -p ../pack && bun pm pack --filename ../pack/beruangai-agentforge.tgz --quiet"
  }
}
```

- **`--filename` takes the path**, since Bun refuses it together with `--destination` (1.4.0).
- **The name is fixed and carries no version**, so a consumer's specifier never changes when the version does. The version stays in the archive's manifest, which tags the AgentForge image as it does today.
- **It packs what `publint --pack npm` already checked.** `bundle` runs publint, and `pack` depends on `bundle`, so a malformed package fails before it is packed.
- **It is an Nx target with its real inputs** (the bundle's), so it is cached and ordered like every other build.

### A consumer depends on the archive by absolute path

```bash
bunx nx add @beruangai/agentforge@/abs/path/to/agentforge/dist/libs/agentforge/pack/beruangai-agentforge.tgz
```

- `nx add` accepts the path: it installs the archive as a dev dependency and runs `init`, as it would for a published version (checked 2026-10-08, Nx 23.2.1).
- **To take a newer AgentForge:** run `pack` in AgentForge, then in the consumer `bun remove @beruangai/agentforge` and `bun add -d` the same path, then `nx sync`. Adding the same path again, even with `--force`, kept the old archive while the lock held its integrity. Removing it first re-reads the archive (Bun 1.4.0). `bun.lock` records the archive's integrity, so the lock changes with each pack; that is expected and committed.
- **An absolute path is the operator's choice for now.** Generated manifests repeat it, and it resolves from all of them. It names one machine's clone, as the plugin's registration already does. A relative path is a recorded limit, not handled.

### A linked install fails at module resolution; no guard

A guard was built, then removed. It required an installed AgentForge's real path to be inside the workspace running it. Tried in the dogfood workspace, a link to the bundle never reached it: loading the plugin fails first, because its own imports resolve from `dist/`. The error reads `Cannot find package '@nx/devkit' imported from …/agentforge/dist/libs/agentforge/bundle/…`. That is loud, and it names the link's target.

The silent case the guard was for needs AgentForge's peers to be reachable from `dist/`. This repository's isolated install never puts them there, and Bun is declared once. The docs name the error signature and its fix instead.

### What the dogfood workspace found, fixed here

- **The preset's `aws-nx-plugin.config.mts` could not be read.** `@aws/nx-plugin` 1.0.6's preset writes `import { AwsNxPluginConfig }`, not `import type`. AgentForge evaluated the file with Node's type stripping, which keeps that import, so `init` failed in every fresh workspace. AgentForge now evaluates it with jiti, as `@aws/nx-plugin` does (its reader is not exported). jiti drops an import used only as a type. The unit fixture now writes the preset's own form. jiti, ^2.7.0 as `@aws/nx-plugin` pins it, becomes a dependency.
- **`connection` did not install the link it adds.** Nx's `installPackagesTask` installs only when the root manifest changed. A connection adds a workspace dependency to the workflow project's own manifest, so the agentic project was never linked, and the workflow project's `typecheck` could not resolve its client. `connection` now always installs.
- **Nx's daemon can sync against a stale graph** right after a generator, so `nx sync:check` failed once after `nx sync` succeeded. With `NX_DAEMON=false`, one `nx sync` converges. The test runs without the daemon. This is not AgentForge's to fix.

### The dogfood test builds a consumer from nothing

`integ/local/package-tarball/` runs, in a temporary directory outside this repository:

1. `create-nx-workspace`, at the Nx version this workspace pins, with `--preset=@aws/nx-plugin --pm=bun`.
2. `bun add` of the archive by absolute path, then the plugin's `init`.
3. `agentic-project`, `agent`, `workflow-project` and `connection`, with small fixed names.
4. `nx sync:check`, `typecheck` across the workspace, `image-<agent>` (building the AgentForge, agentic and agent images from the installed package), and the workflow project's `bundle`.

Then it asserts:
- every generated manifest depends on AgentForge by the absolute path;
- a peer resolved from inside the installed package lands in the consumer's workspace;
- with the package replaced by a link to the bundle, `init` fails, naming the bundle's path.

`integ` gains `pack` in its `dependsOn`, so the archive is current when the test runs. The test needs Docker and the network: the preset and the images install from registries. It is the slowest in `local`, with a timeout to match. It removes the images it built and the temporary workspace afterwards.

## Public API

No TypeScript surface changes. The surface is:
- **the `pack` target**, and the archive at `dist/libs/agentforge/pack/beruangai-agentforge.tgz`;
- **the specifier a consumer writes**: an absolute path to the archive.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| The bundle fails publint | `pack` | `bundle` fails first; nothing is packed |
| The archive is not at the path | the consumer's `bun add` | Bun fails, naming the path |
| AgentForge installed as a link | `init`, any generator, sync or image build | module resolution fails, naming the bundle path a peer was looked up from |
| The installed package lacks the image's inputs | `image-agentforge` | fails, naming each missing path (today's behaviour, now tested installed) |

## What earns which test

- **`integ` local, the dogfood test:** the installed package works end to end in another workspace. AgentForge relies on it for A7. Nothing has run it, and the bundle, the preset and Bun can each drift.
- **Settled once, a dated research note:** how Bun and Node resolve peers through a link, a `file:` directory and a tarball, and that a re-pack is re-read only after `bun remove`. That is the spike. The test's link scenario re-checks that a linked install fails.

## Risks / Trade-offs

- **[The test is slow and needs the network]** → It runs only in `integ` `local`, before publishing, never on every commit. A registry outage fails it loudly; it never passes empty.
- **[The archive path is machine-specific]** → One engineer, one machine, the same as the plugin's registration. A relative path or publishing (A8) removes it.
- **[A consumer re-adds without removing]** → It keeps the old archive. The docs give `bun remove` first.
- **[A consumer forgets to re-install after a pack]** → It runs the older AgentForge until it does. The docs give the three steps, and `nx sync:check` fails once it has re-installed and not synced.
- **[The image tag]** → A consumer tags the AgentForge image `agentforge/a2a-claude:<version>`, and this repository tags its own `:local`, so they don't collide.

## Migration Plan

None in code. In records, `bun link` becomes the archive everywhere it appears: ROADMAP A7, the root README, the package README, the skill, and StrategyFoundry's corrections doc §1 and §11. StrategyFoundry has not yet installed AgentForge, so nothing there migrates.
