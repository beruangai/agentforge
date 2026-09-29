---
status: accepted
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# AgentForge speaks A2A 1.0 only

## Context and Problem Statement

`@a2a-js/sdk` supports A2A 1.0 and 0.3, and negotiates per request from an `A2A-Version` header. An absent header means 0.3, not "unspecified", and AgentCore does not forward the header unless the runtime allowlists it. A2A is AgentForge's transport between its own client and its own runtime; no consumer and no agent ever sees it. Which versions does AgentForge serve?

## Considered Options

* **1.0, with 0.3 accepted underneath** — declare both interfaces, enable `legacyCompat`
* **1.0 only** — declare one interface, disable `legacyCompat`, allowlist the header

## Decision Outcome

Chosen option: **1.0 only**. There is no caller to stay compatible with, so 0.3 is support for nobody — and accepting it turns a configuration mistake into a silent one. With `legacyCompat` enabled, a missing or misspelt `A2A-Version` allowlist entry downgrades every call to 0.3 and the system appears to work on the wrong protocol. With it disabled, the same mistake is refused on the first invocation.

* The card declares **one** interface, `protocolVersion: '1.0'`; `legacyCompat` is disabled on both handlers
* The runtime allowlists **`A2A-Version`**; the client sends `1.0`
* **The client sends `A2A-Version: 1.0` and asserts no version back**: nothing on the wire states the negotiated version — the A2A SDK's server answers with no version header or field, and `InvokeAgentRuntime` passes no container header back — and AgentForge's own client is the only caller, so a mismatch is a bug found in its tests, not in production
* 1.0 method names are the protobuf ones — `SendMessage`, `GetTask`, `CancelTask`
* **A part reader throws on a part it cannot decode.** Under `SendMessage` the SDK will accept a malformed part and drop its content without error, so an empty envelope must never read as an empty request

### Consequences

* Good, because a version mistake fails on the first call instead of running silently on the wrong protocol
* Good, because there is one wire format to implement, test and reason about
* Bad, because the protocol version now depends on runtime configuration — the header allowlist — and not on the image alone
* Bad, because the refusal a misconfigured caller sees is opaque — AgentCore reports it as a 424 indistinguishable from a crash — and the client does not check the version it got
