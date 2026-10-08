# Proposal

## Why

§REQ103 promises that a non-conforming value is never silently dropped. A procedure contract built with Zod's `z.object` breaks that promise: parsing strips undeclared keys and says nothing. Where it bites is a handler's output. `return { ...run.output, results, confidence }` compiles, since TypeScript does not check the excess keys of a spread, and `confidence` never reaches the caller if the contract does not declare it.

The operator decided §ODO001 on 2026-10-08: enforce it. It has to happen before StrategyFoundry writes its contracts, because enforcing it afterwards would break them.

## What Changes

- **A procedure contract whose input or output contains an object that would strip undeclared keys is refused**, by `implementAgent` and by `createClient`. The refusal names the procedure, the side (input or output) and the path, and says what to use instead:
  - `z.strictObject` to refuse undeclared keys;
  - `z.looseObject` to keep them.

  Either is an explicit choice, and both are accepted, as is `.strict()`.
- **Where a refusal surfaces:**
  - **an agent:** its procedure module is loaded by each task's process, never by its server. The server starts and reports healthy, and every task fails `EXECUTION_ERROR`, the refusal in its message. The module's unit tests and the e2e fail the same way, before a deploy;
  - **a caller:** its module throws when it builds its client. The Temporal activity factories take a procedure client `createClient` built, so they need no check of their own.
- **The walk covers every schema that can hold an object:**
  - objects and their catchall;
  - arrays, tuples, records, sets and maps;
  - unions and discriminated unions, intersections;
  - optional, nullable, default, prefault, catch, readonly, nonoptional, success and promise wrappers;
  - pipes and transforms on both sides;
  - lazy schemas, visited once each.

  A schema type it does not know throws, so a Zod upgrade cannot let one through unwalked.
- **AgentForge's own object schemas that a consumer may compose into a contract are strict:** the ones `/contract` exports, `CauseSchema`, `OutcomeSchema`'s branches, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema`. They are also AgentForge's wire, so the rule for reading it across a deploy is written down (ARCHITECTURE §7): it is read strictly and versioned with the package, and until a consumer is live a project and its callers take a new AgentForge version in one deploy.
- **The `agent` generator's scaffolded contract uses `z.strictObject`.**
- **The examples' contracts, and the shared schemas they compose, use `z.strictObject`.** Five places in `golden-kata` parse a value with a narrower schema to drop its extra keys: the grader writing the kata file, and both e2e suites' kata and grade checks. Under strict schemas each would throw, so each narrows explicitly instead.
- **§ODO001 closes**, its outcome recorded in ARCHITECTURE.md.
- **BREAKING:** a contract written with `z.object` is refused. No consumer is live.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-procedure-contract`: a contract that would drop undeclared keys silently is refused before it serves or is called.

## Impact

- **Contract (`/agent`, `/client`):** `implementAgent` and `createClient` refuse such a contract.
- **`/contract`:** its exported object schemas become strict.
- **Plugin:** the agent generator's scaffolded `contract.ts`, with its snapshot.
- **Examples:** `golden-kata`'s and `smoke-coverage`'s contracts, `golden-kata`'s `kata.ts`, the grader's procedure and both `golden-kata` e2e suites. `smoke-coverage`'s `ReportNautilusTraderVersion` is already strict, written so by `glibc-base-image`.
- **Tests:** the package's unit contracts; the integration fixtures' contracts, and the contracts written inline in `integ/local/runtime/runtime.test.ts`.
- **Batch:** the second of four A6 changes, applied in order with no deploy between them: `glibc-base-image`, `strict-contracts`, `project-infrastructure`, `task-image`. Their end-to-end verification runs once, after all four, in `task-image`'s last group. Overlaps:
  - `glibc-base-image` writes `hello-agent`'s new procedure strict; this change makes the rest of its contract strict;
  - this change writes the wire rule into ARCHITECTURE §7, and `task-image` relies on it for the task view's new field.
- **Requirements:**
  - serves §REQ103;
  - keeps §REQ101: refused when the procedure module loads, which a unit test or the e2e reaches, not at type level.
- **Open options:** closes §ODO001.

## Non-goals

- A type-level refusal. Zod's object types carry their strictness only loosely, and a compile error from a deep conditional type is harder to read than the runtime refusal's path.
- Strictness for an agent contract (`runAgent`'s `output`). Structured output closes every object in the schema the model answers to (ARCHITECTURE §6), so the model has no undeclared key to send.
- Refusing at server start. The server never loads the procedure module, and a refusal that fails every task, and every test that loads the module, is as loud.
- Rewriting a consumer's schemas, or a lint rule.
