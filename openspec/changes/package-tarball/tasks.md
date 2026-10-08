# Tasks

Group 1 is the archive. Group 2 was a guard on a linked install, removed. Group 3 proves the installed package from a workspace outside this repository. Group 4 corrects the records.

## 1. The archive

- [x] 1.1 Add the `pack` target to `libs/agentforge/project.json`, as in design.md: cached, depending on `bundle`, writing `dist/libs/agentforge/pack/beruangai-agentforge.tgz`. Add `pack` to `integ`'s `dependsOn`. Verified by `nx run @beruangai/agentforge:pack` writing the archive, a second run read from the cache, and `tar -tzf` on the archive listing the manifest, the entry points, the plugin manifests, the `Dockerfile` and `container/`.

## 2. A linked install

- [x] 2.1 A guard requiring an installed package inside its workspace was built (a1dbd40), then removed: in the dogfood workspace a linked install fails at module resolution, naming the bundle path, before the guard can run (design.md). The README names that error and its fix (4.2), and the test asserts it (3.1).

## 3. The installed package, from another workspace

- [x] 3.1 `libs/agentforge/integ/local/package-tarball/`, as in design.md. In a temporary directory outside this repository, it:
  - creates a preset workspace at this workspace's Nx version;
  - installs the archive by absolute path with `nx add`, which runs `init`;
  - generates an agentic project with an agent, and a workflow project connected to it;
  - runs `nx sync:check`, `typecheck`, the agent's `image-<agent>` and the workflow project's `bundle`.

  It asserts every generated manifest's AgentForge specifier is the absolute path, that a peer resolved from the installed package lands in the consumer's `node_modules`, and that `init` fails naming the bundle's path when the package is replaced by a link to it. It runs Nx without its daemon. It removes its images and workspace afterwards. Verified by `nx run @beruangai/agentforge:integ --configuration=local -- integ/local/package-tarball`.

  A defect it finds in the installed package is fixed in the layer that owns it, within this change, and reported. Found and fixed: the preset's config read with jiti; `connection` always installing (design.md).

## 4. Records

- [x] 4.1 `docs/research/package-installation.md`, dated 2026-10-08: the spike's table (link, `file:` directory, tarball; peers; Bun and Node versions), that a re-pack is re-read only after `bun remove` (re-adding the same path keeps the old archive), and Nx's daemon syncing against a stale graph after a generator. Verified by reading it against the spike in design.md.
- [x] 4.2 Correct every `bun link` record to the archive, and verify each by reading it:
  - **the package README**, "The Nx plugin": adopting before publication (the archive by absolute path, `init`), taking a newer one (`pack`, `bun remove` then `bun add -d`, `nx sync`), the linked-install error's signature, and that a relative path is not supported;
  - **the root README**: the plugin section's line on `bun link`;
  - **ARCHITECTURE §8**: the `pack` target and the archive;
  - **ROADMAP A7**: AgentForge installed from its archive;
  - **the skill**: `SKILL.md`'s Adopt row; `operating.md` if it names the install;
  - **ADR 0019**, context and consequences: amended in place, as no consumer depends on it;
  - **StrategyFoundry's `docs/AGENTFORGE_CORRECTIONS.md`**, §1 and §11, as the only edit there.

  The `integ/local/claude-plugin` link check passes.
