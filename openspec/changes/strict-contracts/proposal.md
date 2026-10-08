# Proposal

## Why

§REQ103 promises that a non-conforming value is never silently dropped. A procedure contract built with Zod's `z.object` breaks that promise: parsing strips undeclared keys and says nothing. Where it bites is a handler's output. `return { ...run.output, results, confidence }` compiles, since TypeScript does not check the excess keys of a spread, and `confidence` never reaches the caller if the contract does not declare it.

The operator decided §ODO001 on 2026-10-08: enforce it. It has to happen before StrategyFoundry writes its contracts, because enforcing it afterwards would break them.

## What Changes

- **A procedure contract whose input or output contains an object that would strip undeclared keys is refused**, when `implementAgent` or `createClient` is given it. The refusal names the procedure, the side (input or output) and the path, and says what to use instead:
  - `z.strictObject` to refuse undeclared keys;
  - `z.looseObject` to keep them.

  Either is an explicit choice, and both are accepted, as is `.strict()`.
- **The walk covers every schema that can hold an object:**
  - objects and their catchall;
  - arrays, tuples, records' values, sets and maps;
  - unions and discriminated unions, intersections;
  - optional, nullable, default, catch, readonly, nonoptional and promise wrappers;
  - pipes and transforms on both sides;
  - lazy schemas, visited once each.
- **AgentForge's own object schemas that a consumer may compose into a contract are strict:**
  - the ones `/contract` exports: `CauseSchema`, `OutcomeSchema`'s branches, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema`;
  - the integration fixtures.
- **The `agent` generator's scaffolded contract uses `z.strictObject`.**
- **The examples' contracts, and the shared schemas they compose, use `z.strictObject`.**
- **§ODO001 closes**, its outcome recorded in ARCHITECTURE.md.
- **BREAKING:** a contract written with `z.object` is refused. No consumer is live.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-procedure-contract`: a contract that would drop undeclared keys silently is refused before it serves or is called.

## Impact

- **Contract (`/agent`, `/client`):** `implementAgent` and `createClient` refuse such a contract. The Temporal activity factories build on `createClient` and refuse it too.
- **`/contract`:** its exported object schemas become strict.
- **Plugin:** the agent generator's scaffolded `contract.ts`, with its snapshot.
- **Examples:** `golden-kata`'s and `smoke-coverage`'s contracts, and `golden-kata`'s `kata.ts`.
- **Tests:** the package's unit and integration contracts.
- **Requirements:**
  - serves §REQ103;
  - keeps §REQ101: refused when the procedure module loads, which an e2e or unit test reaches, not at type level.
- **Open options:** closes §ODO001.

## Non-goals

- A type-level refusal. Zod's object types carry their strictness only loosely, and a compile error from a deep conditional type is harder to read than the runtime refusal's path.
- Strictness for an agent contract (`runAgent`'s `output`). Structured output already closes every object on the wire, so the model cannot send an undeclared key (ARCHITECTURE §6).
- Rewriting a consumer's schemas, or a lint rule.
