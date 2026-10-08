# Tasks

Applied second in the A6 batch, after `glibc-base-image`. Group 1 is the check. Group 2 makes everything AgentForge owns pass it, and lands with group 1 so the package's own tests stay green. Group 3 is the examples. Group 4 closes the records. The e2e runs once for the batch, in `task-image`'s last group.

## 1. The check

- [x] 1.1 `refuseStrippingObjects(contract)` in `core/contract/strict-objects.ts`, walking every procedure's input and output as design.md's table says, throwing on a type it does not know, and naming every offending place and the fix in one error, a line each. Verified by unit tests:
  - a stripping object at the root and nested in an array, a union, an optional and a lazy schema, each with its path;
  - several at once;
  - `strictObject`, `looseObject`, `.strict()` and `.extend` of a strict object accepted;
  - a strict object merged with a `z.object` refused;
  - an unknown type throws;
  - a recursive lazy schema terminates.
- [ ] 1.2 `implementAgent` and `createClient` call it first; `createClient` walks every procedure eagerly. Verified by unit tests:
  - each refuses a contract with a stripping object;
  - a strict output whose handler returns an extra key fails `OUTPUT_INVALID` with the payload;
  - a loose output's extra key is delivered in the outcome.

## 2. What AgentForge owns

- [ ] 2.1 `/contract`'s `CauseSchema`, `OutcomeSchema`'s branches, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema` become strict; the package's unit contracts become strict; the `agent` generator scaffolds `z.strictObject({})`. Verified by `nx run @beruangai/agentforge:test`, the snapshot updated.
- [ ] 2.2 The integration contracts become strict: `integ/local/runtime/__fixtures__/contract.ts`, `integ/local/temporal-worker/__fixtures__/contract.ts`, and the inline contract in `integ/local/runtime/runtime.test.ts`. Verified by `nx run @beruangai/agentforge:integ --configuration=local`.

## 3. Examples

- [ ] 3.1 `golden-kata`'s and `smoke-coverage`'s contracts, and `golden-kata`'s `kata.ts`, use `z.strictObject`. The five places that parse to strip narrow explicitly, as design.md says: `kataOf` in `kata.ts` for the grader and both suites' `kata.json`, and the grader's exported output schema for both suites' grade. Verified by `nx run-many -t typecheck test` for `golden-kata`, `smoke-coverage` and `golden-kata-workflows`; their e2e runs in `task-image`'s last group.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §3:** a contract's objects are strict or loose, never stripping, and refused otherwise, where the refusal surfaces; its contract sample uses `z.strictObject`;
  - **ARCHITECTURE §7:** the wire across a deploy, as design.md states it;
  - **DESIGN_OPTIONS:** §ODO001 removed, its id spent;
  - **the README's "Define a contract":** the example uses `z.strictObject`, with one line on why;
  - **the package README's plugin section:** the scaffolded contract.
