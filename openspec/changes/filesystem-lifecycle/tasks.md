# Tasks

The e2e tests are not rebuilt or run until the operator confirms the implementation.

## 1. Harness

- [x] 1.1 `Filesystem` base class: options, scope, baseline permissions, the mount and unmount lifecycle over `pull` and `push`, checkpoints — verified by unit tests against a scripted kind
- [x] 1.2 `ScratchFilesystem` and `S3Filesystem` (the `s7cmd` engine moved over, write scope as a push filter) — verified by unit tests against a scripted `s7cmd`
- [x] 1.3 `filesystems()` registration middleware and the innermost lifecycle middleware; `executeProcedure` unmounts after the outcome; `FILESYSTEM_UNSYNCED` — verified by unit tests of append, replace and `inherit: false`, mount before the handler, and the outcome per ending
- [x] 1.4 Remove the working-directory API, and move `integ/aws/filesystem-s3-sync` onto `S3Filesystem` — verified by typecheck

## 2. Infra

- [x] 2.1 `S3FilesystemBucket` and `AgentRuntime.filesystems`, with `CKV_AWS_18` left to the consumer's config — verified by construct tests

## 3. Example and docs

- [x] 3.1 `hello-agent`'s notebook on `S3Filesystem`, with its handler applying the baseline permissions; `checkov.yml` takes `CKV_AWS_18` — verified by typecheck and checkov
- [x] 3.2 ADR 0015, ARCHITECTURE, GLOSSARY and README on Filesystem — verified by reading them against this spec

## 4. Integration (after the operator confirms)

- [ ] 4.1 `integ/aws/filesystem-s3-sync` and `hello-agent`'s AgentCore e2e pass
