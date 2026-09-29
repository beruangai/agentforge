# Spec Authoring Guide

Project rules for spec deltas and baseline specs, on top of the built-in `specs` instruction (`openspec instructions specs --change <name>`). That instruction already covers delta operations, scenario format, `## Purpose` for new capabilities, and the behavior-contract quick test; read it first. This guide does not restate it.

## Capability granularity

A capability is a significant observable behavior of the system — a coherent thing the system does, at the altitude an architect or the operator reasons about. It is not a per-schema, per-module, per-service, per-workflow, or per-file slice. Mirroring the implementation's structure in the spec tree is the failure this rule prevents; it is "organize by concept, never by type" applied to specs.

Group related requirements within one capability rather than splitting each into its own.

### Data shapes are implementation

A payload's field-level contract is how a behavior is realized, not a behavior. Structured I/O is everywhere in this system; do not mint a capability per schema, directive input, or record.

- A shape's behavior-relevant semantics live in the capability that acts on them, stated as behavior — what a gate does on each outcome, not the fields of the outcome.
- A convention observable across many behaviors MAY be a small capability of its own — how something is addressed, staged, or recorded. A validated data shape never is.

### Merge or keep separate

**Merge** when candidates share most of: one domain a reader names as a unit; behavior only understood together; they ship together; they depend on the same invariant.

**Keep separate** only for a distinct observable boundary: independently invoked or consumed, its own lifecycle, named by the operator as its own thing. A widely referenced shape is not a boundary.

**A change never absorbs another capability's contract.** When a change alters another capability's behavior, that is a delta on that capability, not a requirement folded into the change's own.

**Size by behaviors, not implementation.** A long spec that mirrors implementation detail needs its altitude raised, not a split.

## Behavior-contract self-check

Run before finishing any spec or delta. Every hit is reworded to observable behavior or deleted:

| Red flag | Reword to |
|---|---|
| File paths — `packages/…`, `examples/…`, `*.ts`, `*.mts` | the capability or behavior |
| Internal symbols — TitleCase identifiers ending in Schema, Client, Factory, Router, Record, Store; module-level constant names | the contract by its observable name |
| Library, framework, or service names — Zod, oRPC, Vitest, Nx, Bun, Docker, DynamoDB, Temporal, CDK | the behavior they provide |
| Step-by-step prescription | the invariant or outcome the steps produce |

**The exceptions.** A borrowed protocol or platform term is required vocabulary, not a red flag: A2A's own names (`SendMessage`, `GetTask`, `TASK_STATE_*`), AgentCore's (a runtime session, a session id), and the Agent SDK's. A tool name is likewise allowed where the tool itself defines externally visible behavior — an AgentCore runtime session's lifetime, Node IPC between the runtime and a task process. "Persisted in DynamoDB" is implementation; "persisted durably and retrievable by identifier" is behavior.

```bash
grep -nEi '(packages/|examples/|\.m?ts\b|\bzod\b|\borpc\b|\bvitest\b|\bnx\b|\bbun\b|\bdocker\b|dynamodb|\btemporal\b|\bcdk\b|[A-Z][a-z]+[A-Z][A-Za-z]*(Schema|Client|Factory|Router|Record|Store)\b)' <spec-file>
```

A clean grep is necessary, not sufficient. Apply the quick test to every requirement as well.

## Cite on first mention

The first mention of a concept owned by another capability links that capability's spec at its synced location under `openspec/specs/`, never the change-scoped path. Later mentions in the same spec may omit the link.

```
... (see [<capability>](../<capability>/spec.md)) ...
```

## Scenarios

Every requirement has a happy-path scenario and, where one applies, an edge or failure scenario. A scenario that cannot become an automated or operator-runnable check is too vague.
