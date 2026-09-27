# Tasks

Groups 1 and 2 were built in `f489b71` on the hand-rolled engine; what remains swaps the engine and tightens the declaration.

## 1. Declaration and construct (built)

- [x] 1.1 `WorkingDirectory` construct (S3-managed, private, TLS-only, retained) and `AgentRuntime.workingDirectories`, verified by construct tests
- [x] 1.2 `WORKING_DIRECTORY_UNSYNCED` cause code, verified by the harness tests
- [x] 1.3 `openWorkingDirectory` in the task context, the outcome waiting for the push, verified by `executeProcedure` tests

## 2. Tighten the declaration

- [x] 2.1 Refuse `deletes` without `pull` or on an empty prefix; `continuous` takes `quietSeconds`; `exclude` holds regular expressions — verified by unit tests of each refusal

## 3. `s7cmd` engine

- [x] 3.1 Install `s7cmd` in the base image, pinned by `ADD --checksum`, and verify `s7cmd --version` in the built image
- [x] 3.2 Replace the hand-rolled engine with `s7cmd sync` run as a child of the task process; verify the arguments and exit-code mapping by unit tests against a scripted runner
- [ ] 3.3 Restore `integ/aws/filesystem-s3-sync` against the base image as built — pull, push, `--check-etag`, `--delete` with exclusion protection, the quiet-period filter, exit codes — and verify it passes as the test role
- [ ] 3.4 Update `docs/research/working-directory-sync.md` to the pinned release and what the integ test established

## 4. Checkov

- [ ] 4.1 Add a `checkov` target and `checkov.yml` to `hello-agent`, following `@aws/nx-plugin`, skipping the KMS rule, and verify it passes on the synthesized stack

## 5. Documentation

- [x] 5.1 ADR 0015 on `s7cmd`; ARCHITECTURE, GLOSSARY and README on the declaration, with deletes and concurrency as the consumer's responsibility; ROADMAP naming StrategyFoundry first — verified by reading them against this spec

## 6. Integration

- [ ] 6.1 `hello-agent`'s AgentCore e2e passes on the `s7cmd` engine, proving its credentials inside the microVM
