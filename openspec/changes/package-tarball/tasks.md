# Tasks

Group 1 is the archive. Group 2 guards a linked install. Group 3 proves the installed package from a workspace outside this repository. Group 4 corrects the records.

## 1. The archive

- [x] 1.1 Add the `pack` target to `libs/agentforge/project.json`, as in design.md: cached, depending on `bundle`, writing `dist/libs/agentforge/pack/beruangai-agentforge.tgz`. Add `pack` to `integ`'s `dependsOn`. Verified by `nx run @beruangai/agentforge:pack` writing the archive, a second run read from the cache, and `tar -tzf` on the archive listing the manifest, the entry points, the plugin manifests, the `Dockerfile` and `container/`.

## 2. A linked install fails loudly

- [ ] 2.1 In `container/container-inputs.ts`, when running installed, throw unless the package directory's real path lies inside the workspace running the plugin, with the message in design.md. Unit tests in `container-inputs.test.ts`: installed inside the workspace passes; installed as a link outside it throws, naming the link and the archive; from source is unaffected. Verified by `nx run @beruangai/agentforge:test`.

## 3. The installed package, from another workspace

- [ ] 3.1 `libs/agentforge/integ/local/package-tarball/`, as in design.md. In a temporary directory outside this repository, it:
  - creates a preset workspace at this workspace's Nx version;
  - installs the archive by absolute path, and runs `init` (with `nx add` if it accepts the path, and records which);
  - generates an agentic project with an agent, and a workflow project connected to it;
  - runs `nx sync:check`, `typecheck`, the agent's `image-<agent>` and the workflow project's `bundle`.

  It asserts every generated manifest's AgentForge specifier is the absolute path, that a peer resolved from the installed package lands in the consumer's `node_modules`, and that `init` fails naming the link when the package is replaced by a link to the bundle. It removes its images and workspace afterwards. Verified by `nx run @beruangai/agentforge:integ --configuration=local -- integ/local/package-tarball`.

  A defect it finds in the installed package is fixed in the layer that owns it, within this change, and reported.

## 4. Records

- [ ] 4.1 `docs/research/package-installation.md`, dated 2026-10-08: the spike's table (link, `file:` directory, tarball; peers; Bun and Node versions), and that `bun add` again picks up a re-pack. Verified by reading it against the spike in design.md.
- [ ] 4.2 Correct every `bun link` record to the archive, and verify each by reading it:
  - **the package README**, "The Nx plugin": adopting before publication (the archive by absolute path, `init`), taking a newer one (`pack`, `bun add` again, `nx sync`), the linked-install error, and that a relative path is not supported;
  - **the root README**: the plugin section's line on `bun link`;
  - **ARCHITECTURE §8**: the `pack` target and the archive;
  - **ROADMAP A7**: AgentForge installed from its archive;
  - **the skill**: `SKILL.md`'s Adopt row; `operating.md` if it names the install;
  - **StrategyFoundry's `docs/AGENTFORGE_CORRECTIONS.md`**, §1 and §11, as the only edit there.

  The `integ/local/claude-plugin` link check passes.
