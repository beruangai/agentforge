# Design

## Context

See proposal.md — Why. What holds today:

- **The two entry points.**
  - `implementAgent(contract)` (`server/harness/task-process.ts`) is `implement(contract).$context<TaskContext>()`.
  - `createClient(contract, transport)` (`client/client.ts`) builds its procedure clients lazily, through a proxy.
  - `listProcedures(contract)` and `inputSchemaOf`/`outputSchemaOf` (`core/contract/procedures.ts`) enumerate a contract's procedures and their schemas.
- **Zod 4 marks strictness on the object's definition.** Observed 2026-10-08 on the installed `zod`:

  | Schema | `_zod.def.catchall` |
  |---|---|
  | `z.object` | absent, so it strips |
  | `z.strictObject`, and `.strict()` | `never` |
  | `z.looseObject` | `unknown` |

  `.extend`, `.pick`, `.partial` and `.merge` with a strict object keep `never`.
- **Where `z.object` sits in contracts and the schemas they compose:**
  - the examples' `contract.ts` files and `golden-kata`'s `kata.ts`;
  - the `agent` generator's scaffold (`scaffolds.ts`: `.input(z.object({})).output(z.object({}))`);
  - the package's own unit and integration contracts;
  - `/contract`'s exported schemas (`task.ts`, `envelope.ts`).
- **What an output that fails its contract does:** the task fails `OUTPUT_INVALID`, carrying the payload (`core-procedure-contract`).

## Goals / Non-Goals

**Goals:**
- No contract AgentForge serves or calls can drop a key silently.
- A refusal that says exactly where and what to write instead.

**Non-Goals:** as in proposal.md.

## Decisions

### One walk, at both entry points

```ts
// core/contract/strict-objects.ts
/**
 * Throws, naming each place, when any procedure's input or output holds an
 * object that strips undeclared keys (§REQ103). Every other schema is walked
 * through to the objects it can hold; a lazy schema is visited once.
 */
export function refuseStrippingObjects(contract: RouterContract): void;
```

- **`implementAgent`** calls it first, so an agent's procedure module fails to load, which fails its server's start, its unit tests and its e2e.
- **`createClient`** calls it before returning, walking every procedure eagerly rather than through the lazy proxy. A caller's module therefore fails when it builds its client. The Temporal activity factories build on `createClient`, so they refuse too.

**What it reads:** each object's `_zod.def`. The walk is:

| Definition | Walked into |
|---|---|
| `object` | refused when its `catchall` is absent; otherwise each shape value and the catchall |
| `array`, `set` | the element |
| `tuple` | the items and the rest |
| `record`, `map` | the key and the value |
| `union` (discriminated or not) | each option |
| `intersection` | both sides |
| `optional`, `nullable`, `default`, `prefault`, `catch`, `readonly`, `nonoptional`, `promise` | the inner type |
| `pipe` | in and out |
| `lazy` | the getter's schema, once per schema object |
| every other type | nothing; it holds no object |

**What one refusal names:** every offending place, not only the first. A path reads `Write.output.kata.cases[]`.

```
procedure contract refused (§REQ103): these objects drop keys they do not name, silently:
  Write.output.kata.cases[] — z.object
Use z.strictObject to refuse undeclared keys, or z.looseObject to keep them.
```

`_zod.def` is Zod's own documented introspection surface in v4 (`schema._zod.def`). A future Zod that moves it fails the walk's unit tests, never silently.

*Alternatives:*
- **Make every object strict on the way in**, by rewriting the schema. That silently changes a schema the consumer wrote, and is the opposite of telling them.
- **Only the output side.** An input that strips a caller's typo is the same silent drop seen from the other end, and refusing both costs nothing more.
- **A type-level check** (non-goal): it gives a worse error for the same guarantee.

### AgentForge's composable schemas are strict

`CauseSchema`, each branch of `OutcomeSchema`, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema` become `z.strictObject`:
- a consumer composing one into a contract, such as a workflow returning a cause, is served;
- AgentForge's own wire reads become strict too: a field one side writes and the other does not know fails loudly.

The client and server ship in one package, and the contract hash already refuses a mismatched contract.

### The scaffold and the examples

- The `agent` generator scaffolds `.input(z.strictObject({})).output(z.strictObject({}))`.
- The examples' contracts and `golden-kata`'s `kata.ts` move to `z.strictObject`.
- Nothing in the examples relies on stripping; if a test shows otherwise, that is a hidden drop this change exists to surface, and it is fixed in the example.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| A contract with a stripping object | `implementAgent` or `createClient` | throws, naming every place and the fix; the agent's server or the caller's module fails to start |
| A handler returning a key a strict output does not declare | the task's end | `TASK_STATE_FAILED`, `OUTPUT_INVALID`, the payload carried |
| A caller sending a key a strict input does not declare | admission | `TASK_STATE_REJECTED`, naming the key; it was dropped before |
| A wire read meeting a key AgentForge's strict schema does not declare | the client reading a task | throws: the task cannot be read |

## What earns which test

- **Unit:**
  - **The walk:**
    - one stripping object at the root, nested in an array, a union, an optional and a lazy schema, each named by its path;
    - several refused at once;
    - `strictObject`, `looseObject`, `.strict()` and their `.extend` accepted;
    - a recursive lazy schema terminates.
  - **`implementAgent` and `createClient`:** each refuses such a contract.
  - **A strict output:** a handler returning an extra key fails `OUTPUT_INVALID` (`task-process.test.ts`).
  - **The generator's snapshot.**
- **Integration:** `integ` local re-runs with its strict fixtures.
- **e2e:**
  - `golden-kata` and `smoke-coverage` locally, with their strict contracts. The AgentCore suites need no re-run, because the change is in code both places run identically.
  - The workflow project's `test` and `e2e` locally, since its activities build `createClient`.
- **No platform behaviour** is relied on.

## Risks / Trade-offs

- [A wire field added to one side breaks the other's strict read] → Client and server are versioned together, and the failure is loud.
- [Zod's `_zod.def` changes shape] → The walk's tests fail on upgrade. It is Zod's documented internals surface, and AgentForge adopts new majors deliberately.
