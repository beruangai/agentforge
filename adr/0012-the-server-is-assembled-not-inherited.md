---
status: accepted
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# The server is assembled, not inherited

## Context and Problem Statement

The runtime must serve A2A on AgentCore's contract: port 9000, JSON-RPC on `/`, an agent card, and a `/ping` answering `Healthy` or `HealthyBusy`. A gateway sits in front of the executor to decide idempotency, admission and cancellation before a task exists. AWS ships `serveA2A` in `bedrock-agentcore`, which builds the same server. Do we depend on it or assemble our own?

## Considered Options

* **Depend on `serveA2A`** — pass an executor, let it construct the app
* **Assemble from `@a2a-js/sdk` and Express** — construct the request handler ourselves

## Decision Outcome

Chosen option: **assemble from `@a2a-js/sdk` and Express**, because `serveA2A` takes an executor and constructs `DefaultRequestHandler` itself, leaving no seam for a gateway — and a gateway is not optional, since idempotency and admission must be decided before a task id is minted. It is also absent from the latest published `bedrock-agentcore`.

* The gateway **implements `A2ARequestHandler`** and delegates to `DefaultRequestHandler` for everything it does not intercept
* AgentCore's contract mechanics are ported deliberately: port 9000 from `A2A_PORT`, bind `0.0.0.0`, the `/ping` shape, and `UserBuilder.noAuthentication` because AgentCore terminates authentication in front of the container
* The card's `url` is rewritten by the platform, so the container never declares its own public address

### Consequences

* Good, because the gateway is a seam rather than a fork, and every A2A method keeps its SDK behaviour
* Good, because the protocol version is ours to choose rather than the wrapper's
* Bad, because AgentForge owns roughly eighty lines of AgentCore-contract mechanics that AWS also maintains, and must track them as that contract moves
