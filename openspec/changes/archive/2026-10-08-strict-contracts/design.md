# Design

## Context

See proposal.md — Why. What holds today:

- **The two entry points.**
  - `implementAgent(contract)` (`server/harness/task-process.ts`) is `implement(contract).$context<TaskContext>()`. An agent's `procedures.ts` calls it, and only its task entry (`task.ts`) imports that module, in each task's process; the server (`server.ts`) never loads it.
  - `createClient(contract, transport)` (`client/client.ts`) builds its procedure clients lazily, through a proxy. The Temporal activity factories (`procedureActivity`, the project activities) take procedure clients it built.
  - `listProcedures(contract)` and `inputSchemaOf`/`outputSchemaOf` (`core/contract/procedures.ts`) enumerate a contract's procedures and their schemas.
- **A task process that exits without an outcome** fails its task `EXECUTION_ERROR`, "the task process exited without reporting an outcome; stderr ends: …", carrying the last 4,000 bytes of its stderr (`server/runtime/executor.ts`).
- **The contract hash cannot tell the object kinds apart.** `contractHash` renders the output side with `z.toJSONSchema(…, { io: 'output' })`, which writes `additionalProperties: false` for a stripping and a strict object alike. A caller's `z.object` therefore hashes equal to an agent's `z.strictObject`, and the caller's own parse would strip; only a check in `createClient` sees it.
- **Zod 4 marks strictness on the object's definition.** Observed 2026-10-08 on the installed `zod` (4.6.5):

  | Schema | `_zod.def.catchall` |
  |---|---|
  | `z.object` | absent, so it strips |
  | `z.strictObject`, and `.strict()` | `never` |
  | `z.looseObject` | `unknown` |

  `.extend`, `.pick` and `.partial` keep the object's catchall. `.merge` takes its argument's: a strict object merged with a `z.object` strips, which the walk refuses like any other.
- **Where `z.object` sits in contracts and the schemas they compose:**
  - the examples' `contract.ts` files and `golden-kata`'s `kata.ts`;
  - the `agent` generator's scaffold (`scaffolds.ts`: `.input(z.object({})).output(z.object({}))`);
  - the package's unit contracts, among them `client/temporal/workflow/__fixtures__/contract.ts` and the inline ones in `client.test.ts`, `project-activities.test.ts` and `task-process.test.ts`;
  - the integration contracts: `integ/local/runtime/__fixtures__/contract.ts`, `integ/local/temporal-worker/__fixtures__/contract.ts`, and the inline one in `integ/local/runtime/runtime.test.ts`;
  - `/contract`'s exported schemas (`task.ts`, `envelope.ts`).

  The `z.object`s in `integ/model/` are agent contracts (`runAgent`'s `output`), outside this change.
- **Where the examples parse to strip.** Five places parse a value with a narrower schema so that its extra keys are dropped:
  - `golden-kata/agents/grader/agent/procedures.ts`: `KataSchema.parse(input.kata)`, a written kata, to write `kata.json` without the difficulty and reference solution;
  - both e2e suites' `independentResults`: `KataSchema.parse(kata)`, the same;
  - `golden-kata/e2e/golden-kata.suite.ts` and `golden-kata-workflows/e2e/golden-kata-workflows.suite.ts`: `GradeSchema.parse(…)` of the grader's output, which also carries `results`.
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

- **`implementAgent`** calls it first. The agent's procedure module then throws on load, so:
  - its unit tests and its e2e fail;
  - deployed, the server starts and reports healthy, and every task fails `EXECUTION_ERROR` with the refusal at the head of its stderr tail.
- **`createClient`** calls it before returning, walking every procedure eagerly rather than through the lazy proxy. A caller's module therefore throws when it builds its client, and a Temporal worker's when it registers activities built on that client. Its check is not redundant with the agent's: the contract hash cannot tell a stripping object from a strict one (Context), so a caller holding a `z.object` copy of a strict contract would otherwise strip on its own parse.

**What it reads:** each schema's `_zod.def.type`. The walk is:

| Definition | Walked into |
|---|---|
| `object` | refused when its `catchall` is absent; otherwise each shape value and the catchall |
| `array`, `set` | the element |
| `tuple` | the items and the rest |
| `record`, `map` | the key and the value |
| `union` (discriminated or not) | each option |
| `intersection` | both sides |
| `optional`, `nullable`, `default`, `prefault`, `catch`, `readonly`, `nonoptional`, `success`, `promise` | the inner type |
| `pipe` | in and out |
| `lazy` | the getter's schema, once per schema object |
| `string`, `number`, `bigint`, `boolean`, `date`, `symbol`, `undefined`, `null`, `void`, `any`, `unknown`, `never`, `nan`, `literal`, `enum`, `template_literal`, `file`, `transform`, `custom`, `function` | nothing; it holds no object |
| any other | throws, naming the type: the walk does not know it |

**What one refusal names:** every offending place, not only the first, one line each, so the message stays well inside the stderr tail. A path reads `Write.output.kata.cases[]`.

```
procedure contract refused (§REQ103): these objects drop keys they do not name, silently:
  Write.output.kata.cases[] — z.object
Use z.strictObject to refuse undeclared keys, or z.looseObject to keep them.
```

`_zod.def` is Zod's own documented introspection surface in v4 (`schema._zod.def`). A future Zod that moves it, or adds a type, fails the walk loudly, never silently.

*Alternatives:*
- **Make every object strict on the way in**, by rewriting the schema. That silently changes a schema the consumer wrote, and is the opposite of telling them.
- **Only the output side.** An input that strips a caller's typo is the same silent drop seen from the other end, and refusing both costs nothing more.
- **Refuse at server start**, by having the server load the procedure module. It would make the server import what only the task process imports today, for a failure every task and every test already reports.
- **A type-level check** (non-goal): it gives a worse error for the same guarantee.

### AgentForge's composable schemas are strict

`CauseSchema`, each branch of `OutcomeSchema`, `RunRecordSchema`, `PriorAttemptSchema` and `EnvelopeSchema` become `z.strictObject`:
- a consumer composing one into a contract, such as a workflow returning a cause, is served;
- AgentForge's own wire reads become strict too: a field one side writes and the other does not know fails loudly.

The A2A objects around them (the client's `WireTaskSchema`, the task protocol's messages) are not contracts and are unchanged.

### The wire across a deploy

Recorded in ARCHITECTURE §7, and relied on by `task-image`:
- AgentForge's wire is read strictly and versioned with the package; a field is added to both sides in one version.
- While a deploy is under way, a caller and an agent on different versions may fail to read each other's tasks. In the Temporal activity a failed read is a failed attempt: its retry attaches to the same task, by its idempotency key, once both sides run the new version. Any other caller retries its read.
- Until a consumer is live, a project and its callers take a new AgentForge version in one deploy.

### The scaffold and the examples

- The `agent` generator scaffolds `.input(z.strictObject({})).output(z.strictObject({}))`.
- The examples' contracts and `golden-kata`'s `kata.ts` move to `z.strictObject`.
- The five places that parse to strip narrow explicitly instead:
  - `kata.ts` gains `kataOf(written: WrittenKata): Kata`, which destructures away `difficulty` and `referenceSolution`. The grader and both suites write `kata.json` from it;
  - the grader's contract exports its output schema (`GradeSchema` extended with `results`), and both suites parse the grade with it.
- Nothing else in the examples relies on stripping; if a test shows otherwise, that is a hidden drop this change exists to surface, and it is fixed in the example.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| An agent's contract with a stripping object | its procedure module loads: each task's process, a unit test, the e2e | throws, naming every place and the fix; deployed, the server is healthy and each task fails `EXECUTION_ERROR`, the refusal in its message |
| A caller's contract with a stripping object | `createClient` | throws, naming every place and the fix; the caller's module fails to load |
| A schema type the walk does not know | either entry point | throws, naming the type |
| A handler returning a key a strict output does not declare | the task's end | `TASK_STATE_FAILED`, `OUTPUT_INVALID`, the payload carried |
| A caller sending a key a strict input does not declare | admission | `TASK_STATE_REJECTED`, naming the key; it was dropped before |
| A wire read meeting a key AgentForge's strict schema does not declare | the client reading a task | throws: the task cannot be read; as the wire rule says |

## What earns which test

- **Unit:**
  - **The walk:**
    - one stripping object at the root, nested in an array, a union, an optional and a lazy schema, each named by its path;
    - several refused at once;
    - `strictObject`, `looseObject`, `.strict()` and their `.extend` accepted;
    - a strict object merged with a `z.object` refused;
    - an unknown type throws;
    - a recursive lazy schema terminates.
  - **`implementAgent` and `createClient`:** each refuses such a contract.
  - **A strict output:** a handler returning an extra key fails `OUTPUT_INVALID` (`task-process.test.ts`).
  - **A loose output:** a handler's extra key is delivered in the outcome (`task-process.test.ts`).
  - **The generator's snapshot.**
- **Integration:** `integ` local re-runs with its strict contracts.
- **e2e,** in the batch's joint verification (`task-image`'s last group): `golden-kata`, `smoke-coverage` and `golden-kata-workflows` with their strict contracts. Nothing here differs between local and AgentCore, so the local runs are the evidence; the AgentCore runs happen for the batch's other changes.
- **No platform behaviour** is relied on.

## Risks / Trade-offs

- [A wire field added to one side breaks the other's strict read] → The wire rule: versioned together, one deploy until a consumer is live, and the failure is loud.
- [A refused agent deploys healthy and fails every task] → Its unit tests and e2e load the module first and fail; deployed, the refusal is in every task's message.
- [Zod's `_zod.def` changes shape, or gains a type] → The walk throws on what it does not know, and its tests fail on upgrade. It is Zod's documented internals surface, and AgentForge adopts new majors deliberately.
