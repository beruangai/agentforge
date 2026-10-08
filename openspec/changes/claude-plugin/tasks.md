# Tasks

Group 1 is the marketplace, the plugin and the local check. Group 2 is the guide itself. Group 3 proves registration against a real session start. Group 4 dogfoods it here. Group 5 closes the records and A6.

## 1. The marketplace and the plugin

- [x] 1.1 Add the marketplace and the plugin at the repository root:
  - `.claude-plugin/marketplace.json`: the marketplace `agentforge`, listing the plugin `agentforge` at `./claude-plugin`;
  - `claude-plugin/.claude-plugin/plugin.json`;
  - `claude-plugin/skills/agentforge/SKILL.md`, with its frontmatter `name` and `description`, its body a placeholder until 2.1.

  Verified by `claude plugin validate .` and `claude plugin validate claude-plugin` passing.
- [x] 1.2 `libs/agentforge/integ/local/claude-plugin/`, running the `claude` binary from the SDK's platform package. It checks:
  - `claude plugin validate` passes on the repository root and on `claude-plugin/`;
  - every relative link in the skill and its references resolves to a file in the repository.

  Verified by `nx run @beruangai/agentforge:integ --configuration=local -- integ/local/claude-plugin`, and by the link check failing on a deliberately broken link before it is reverted.

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

  Each reference links the repository's docs (the root README, `libs/agentforge/README.md`, ARCHITECTURE) by relative path for what is generated and maintained, rather than restating it. Verified by the local check, and by the operator reading it.
- [ ] 2.2 Write `references/migrations.md`: its convention (one entry per breaking change set, newest first, headed by milestone and date until published; what breaks, what to change, how to verify), and the A6 entry:
  - contracts strict or loose;
  - agent constructs taking their project's resources, with `removalPolicy` and `sessionRetention` on the project;
  - `TaskView.image`;
  - the Debian image, and a detached `base/Dockerfile` installing with `apt-get`.

  Verified by the local check, and by the operator reading it.

## 3. Registration

- [x] 3.1 `libs/agentforge/integ/local/claude-plugin/`, on the SDK's `claude` binary, in an isolated config directory with no credential and no turn:
  - the marketplace is registered at user scope from the repository root, with `enabledPlugins: { "agentforge@agentforge": false }`;
  - a fixture project enabling the plugin in `.claude/settings.json` lists the skill in its session's `initialize` response;
  - a fixture project not enabling it does not list it.

  Verified by `nx run @beruangai/agentforge:integ --configuration=local -- integ/local/claude-plugin`, and by the enabled case failing with the marketplace's source pointed at a missing directory before it is reverted.

## 4. Dogfood

- [ ] 4.1 This repository's `.claude/settings.json` enables `agentforge@agentforge`. The root README's "Claude Code plugin" section gives:
  - the registration command from a local clone, at user scope;
  - the user-scope `false`, and the per-project `true` in either settings file;
  - that a machine registers one clone, and registering again after the clone moves.

  The package README points to it. The operator registers this clone on this machine. Verified by the operator:
  - a new session here lists the skill;
  - asked to add a procedure to `smoke-coverage`'s agent, the session uses the skill.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **REQUIREMENTS:** §REQ712 added;
  - **ADR 0019:** proposed, linked from design.md, in the ADR index;
  - **ARCHITECTURE §8:** the repository is a Claude Code marketplace, registered from a local clone, and the plugin's layout;
  - **GLOSSARY:** the AgentForge plugin;
  - **the root README:** points to the plugin for the guide;
  - **`CLAUDE.md`, Working rules:** a change to what a consumer writes or runs updates the skill, and a breaking one adds its migration entry;
  - **ROADMAP:** the plugin delivered, and A6 delivered.
- [ ] 5.2 StrategyFoundry's `docs/AGENTFORGE_CORRECTIONS.md` gains a section on enabling the plugin — registration and the project setting — as the only edit there. Verified by reading it.
