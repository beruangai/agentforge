# Installing AgentForge before it is published — spiked 2026-10-08

How a consumer's workspace can install `@beruangai/agentforge` from a local clone, so the package it runs is the one publishing would ship. Spiked on Bun 1.4.0 and Node 26.8.2, against the bundle (`dist/libs/agentforge/bundle`), in consumers outside this repository.

**Only a packed tarball resolves AgentForge's peers from the consumer.**

| Install | AgentForge in the consumer | Peers resolve from | Result |
|---|---|---|---|
| `bun link` | a symlink to the bundle | the bundle's real path under `dist/` | `Cannot find package 'zod'`, under Bun and Node |
| `bun add <pkg>@file:<bundle directory>` | a directory of per-file symlinks into the bundle | the same | the same |
| `bun pm pack` in the bundle, then `bun add <pkg>@<tarball>` | real files | the consumer's `node_modules` | works; AgentForge's schemas are instances of the consumer's Zod, under Bun and Node |

- Where a peer *is* reachable from the bundle's real path, a linked install silently uses AgentForge's copy instead. This repository's isolated install keeps them unreachable, so in practice a linked install fails at module resolution. The plugin's own imports fail first: `Cannot find package '@nx/devkit' imported from …/dist/libs/agentforge/bundle/…`.
- `bun pm pack` refuses `--filename` together with `--destination`; `--filename` takes a path.

**A re-packed tarball at the same path is re-read only after `bun remove`.** With the consumer's lock holding the old tarball's integrity, `bun add <pkg>@<same path>` (with or without `--force`) kept the old package. `bun remove <pkg>`, then `bun add`, installed the new one. One earlier run, where the lock had just changed source, did pick up a re-pack on `bun add` alone, so re-adding is not to be relied on.

**`nx add <pkg>@<absolute path to the tarball>` works** (Nx 23.2.1): it installs the tarball as a dev dependency and runs the plugin's `init`.

**Nx's daemon can sync against a stale project graph right after a generator.** In a fresh preset workspace, after `connection`, `nx sync` reported success but left `@nx/js:typescript-sync`'s project reference unwritten, and `nx sync:check` failed. With `NX_DAEMON=false`, one `nx sync` converged.

**`@aws/nx-plugin` 1.0.6's preset writes `import { AwsNxPluginConfig }`, not `import type`,** in `aws-nx-plugin.config.mts`. It reads the file with jiti, which drops an import used only as a type; Node's `stripTypeScriptTypes` keeps it. Its reader is not exported (the package exports types only from its root).
