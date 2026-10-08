# Tasks

Group 1 is the plugin's shape and its unit test. Group 2 is the guide itself. Group 3 ships it in the bundle and proves registration against a real session. Group 4 dogfoods it here. Group 5 closes the records and A6.

## 1. The marketplace and the plugin

- [ ] 1.1 Add the marketplace and the plugin:
  - `libs/agentforge/.claude-plugin/marketplace.json`: the marketplace `agentforge`, listing the plugin `agentforge` at `./claude-plugin`;
  - `libs/agentforge/claude-plugin/.claude-plugin/plugin.json`;
  - `claude-plugin/skills/agentforge/SKILL.md`, with its frontmatter `name` and `description`, its body a placeholder until 2.1.

  Verified by `claude plugin validate libs/agentforge` and `claude plugin validate libs/agentforge/claude-plugin` passing.
- [ ] 1.2 `claude-plugin/plugin-guidance.test.ts`. The unit config's `include` and the `test` target's inputs cover `claude-plugin/**` and `.claude-plugin/**`. The test checks:
  - both manifests parse and name `agentforge`;
  - the marketplace's source is the plugin directory;
  - the skill's frontmatter has `name` and `description`;
  - every relative link in the skill and its references resolves to a file inside the package.

  Verified by `nx run @beruangai/agentforge:test`, and by the link check failing on a deliberately broken link before it is reverted.

## 2. The guide

- [ ] 2.1 Write `SKILL.md` and `references/implementing.md`, `consuming.md` and `operating.md`. Content, from ARCHITECTURE, the root README and the package README as they stand:
  - **`SKILL.md`:** when the skill applies; the loop (adopt → generate → define → implement → consume → run); which reference serves each step.
  - **`implementing.md`:**
    - a contract, strict or loose objects;
    - `composeOptions(baseOptions(), context.agentOptions, …)`;
    - `composeContext` with fragments;
    - several runs, and none;
    - stop guards;
    - filesystems, and `memoryDirectory` over a memories bucket;
    - `distill`;
    - side effects as code around a run, chained with `.then` or after `await`, never an `onSuccess`;
    - `attempt` and `priorAttempt` for recovery;
    - code an agent runs ships as a file in its layer, under the read fence.
  - **`consuming.md`:**
    - the project client;
    - `SendMessage`, `GetTask` and `awaitTask`;
    - refusals;
    - workflow projects and connections;
    - `procedureActivity` timeouts.
  - **`operating.md`:**
    - the targets;
    - credentials per target;
    - serve and e2e;
    - deploy with the operator's credentials;
    - detaching a maintained file;
    - the known limits.

  Each reference links the package README for what is generated and maintained, rather than restating it. Verified by the unit test's link check, and by the operator reading it.
- [ ] 2.2 Write `references/migrations.md`: its convention (one entry per breaking change set, newest first, what breaks, what to change, how to verify), and the A6 entry:
  - contracts strict or loose;
  - agent constructs taking their project's resources, with `removalPolicy` and `sessionRetention` on the project;
  - `TaskView.image`;
  - the Debian image, and a detached `base/Dockerfile` installing with `apt-get`.

  Verified by the unit test and by the operator reading it.

## 3. Shipping it

- [ ] 3.1 The bundle copies `.claude-plugin/` and `claude-plugin/` with their layout, excluding the test. Verified by `nx run @beruangai/agentforge:bundle`, with publint passing, and by `npm pack --dry-run` in `dist/libs/agentforge/bundle` listing the marketplace, the plugin manifest, `SKILL.md` and its references.
- [ ] 3.2 `integ/model/claude-plugin/`. Against the bundle, in an isolated config directory:
  - the marketplace is registered at user scope with `enabledPlugins: { "agentforge@agentforge": false }`;
  - a fixture project enabling the plugin in `.claude/settings.json` reports the skill in its session's `init`;
  - a fixture project not enabling it does not report it.

  Verified by `nx run @beruangai/agentforge:integ --configuration=model -- integ/model/claude-plugin`.

## 4. Dogfood

- [ ] 4.1 This repository's `.claude/settings.json` enables `agentforge@agentforge`. The package README's "Claude Code plugin" section gives the registration command, the user-scope `false`, the per-project `true` in either settings file, the one-install-per-machine limit, and re-registering after the install moves. The operator registers the marketplace on this machine from `node_modules/@beruangai/agentforge`. Verified by the operator:
  - a new session here lists the skill;
  - asked to add a procedure to `smoke-coverage`'s agent, the session uses the skill.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **REQUIREMENTS:** §REQ712 added;
  - **ADR 0019:** proposed, linked from design.md, in the ADR index;
  - **ARCHITECTURE §8:** the package ships the Claude Code plugin, and its layout;
  - **GLOSSARY:** the AgentForge plugin;
  - **the root README:** points to the plugin for the guide;
  - **`CLAUDE.md`, Working rules:** a change to what a consumer writes or runs updates the skill, and a breaking one adds its migration entry;
  - **ROADMAP:** the plugin delivered, and A6 delivered.
- [ ] 5.2 StrategyFoundry's `docs/AGENTFORGE_CORRECTIONS.md` gains a section on enabling the plugin — registration and the project setting — as the only edit there. Verified by reading it.
