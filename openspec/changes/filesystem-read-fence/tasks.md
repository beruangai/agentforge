# Tasks

Group 1 is the package work. Group 2 runs the fence against a real model. Group 3 lands it on the scaffold and the examples, and needs group 1. Group 4 closes the records.

## 1. Directories, not read scopes

- [x] 1.1 `FilesystemScope.read` is removed: a scope carrying it fails `EXECUTION_ERROR` before anything is mounted, naming the key. A mount's baseline rules are `Read(/<localPath>/**)` and `Edit(/<localPath>/<write>)`. `TaskContext.filesystemDirectories` lists every mounted `localPath`. Verified by unit tests, `nx run @beruangai/agentforge:test`:
  - the baseline rules;
  - `filesystemDirectories` with two mounts and with none;
  - a scope carrying `read` refused.

## 2. Against a real model

- [ ] 2.1 `integ/model/read-fence/read-fence.test.ts` through `runAgent`, fenced, in a sandbox: one directory given as `additionalDirectories`, and a sibling directory named by a `Read` allow rule. Verified by `nx run @beruangai/agentforge:integ --configuration=model -- integ/model/read-fence`:
  - the tool results show a `Read` of the given directory succeeding;
  - a `Read` of the sibling is refused, and so is `cat` of it through Bash.

## 3. Scaffold and examples

- [ ] 3.1 The base-options scaffold sets `settings.permissions.blockReadsOutsideWorkingDirectories: true`. Verified by the agentic-project generator's snapshot test.
- [ ] 3.2 golden-kata's and smoke-coverage's base options gain the setting. Their procedures pass `additionalDirectories: [...context.filesystemDirectories]` beside the allow rules; golden-kata's `baseOptions(directory)` keeps its own directory. Verified by `nx run @beruangai/golden-kata:e2e`, `nx run @beruangai/smoke-coverage:e2e`, and both `e2e-agentcore` targets after their deploys.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §3, the filesystems paragraph:** `filesystemDirectories`, mounts as working directories, the fence as the house default, no read scope;
  - **ADR 0015, mutated in place:** the scope bullet without `read`, the handler receiving the directories;
  - **the root README's note on permissions:** the fence and what it does not cover;
  - **GLOSSARY:** the read fence.
