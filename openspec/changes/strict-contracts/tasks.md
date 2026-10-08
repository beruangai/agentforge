# Tasks

Group 1 is the check. Group 2 makes everything AgentForge owns pass it, and lands with group 1 so the package's own tests stay green. Group 3 is the examples. Group 4 closes the records.

## 1. The check

- [ ] 1.1 `refuseStrippingObjects(contract)` in `core/contract/strict-objects.ts`, walking every procedure's input and output as design.md's table says, and naming every offending place and the fix in one error. Verified by unit tests:
  - a stripping object at the root and nested in an array, a union, an optional and a lazy schema, each with its path;
  - several at once;
  - `strictObject`, `looseObject`, `.strict()` and `.extend` of a strict object accepted;
  - a recursive lazy schema terminates.
- [ ] 1.2 `implementAgent` and `createClient` call it first; `createClient` walks every procedure eagerly. Verified by unit tests: each refuses a contract with a stripping object, and a strict output whose handler returns an extra key fails `OUTPUT_INVALID` with the payload.

## 2. What AgentForge owns

- [ ] 2.1 `/contract`'s `CauseSchema`, `OutcomeSchema`'s branches, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema` become strict; the package's unit contracts and the `integ` fixtures' contracts become strict; the `agent` generator scaffolds `z.strictObject({})`. Verified by `nx run @beruangai/agentforge:test` (the snapshot updated), and by `nx run @beruangai/agentforge:integ --configuration=local`.

## 3. Examples

- [ ] 3.1 `golden-kata`'s and `smoke-coverage`'s contracts, and `golden-kata`'s `kata.ts`, use `z.strictObject`. Verified by `nx run-many -t typecheck test` for the examples and `golden-kata-workflows`, by `nx run @beruangai/golden-kata:e2e` and `nx run @beruangai/smoke-coverage:e2e`, and by `nx run @beruangai/golden-kata-workflows:e2e`.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §3:** a contract's objects are strict or loose, never stripping, and refused otherwise;
  - **DESIGN_OPTIONS:** §ODO001 removed, its id spent;
  - **the README's "Define a contract":** the example uses `z.strictObject`, with one line on why;
  - **the package README's plugin section:** the scaffolded contract.
