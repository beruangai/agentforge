---
status: proposed
date: 2026-09-20
decision-makers: Jeremy Jonas
---

# AgentForge is consumed as an Nx plugin, and agents nest in one project

## Context and Problem Statement

A consumer adopting AgentForge has to scaffold a project, write a Dockerfile for an ARM64 image, wire an A2A server, provision an AgentCore runtime with its stores and IAM, publish bundles, and build a typed client for its callers. Done by hand, each consumer does it differently and drifts. `@aws/nx-plugin` already solves this shape for Strands agents — its `ts#agent` generator scaffolds the project, the A2A server, CDK constructs with `grantInvokeAccess`, and a client factory — but it is purpose-built for Strands, so another framework needs its own generator. How is AgentForge delivered, and how are a consumer's several agents laid out?

## Considered Options

For delivery: **libraries plus documentation**, or **an Nx plugin following `@aws/nx-plugin`'s conventions**.

For layout: **one project per agent**, with a shared project holding the image and constructs, or **one agents project holding several nested agent definitions**.

## Decision Outcome

Chosen: **an Nx plugin**, with **agents nested in one project** by default.

* Generators produce an agents project with its image, an additional agent inside one, a procedure, and the caller's client wiring; the CDK constructs and the bundle publish command ship alongside, so the runtime, its mount, and what is published cannot drift apart
* Nesting follows from the bundle decision ([ADR 0008](0008-procedure-code-is-a-published-bundle.md)): agents on one image differ only by bundle and card, so one project builds one image and each agent keeps its own build and deploy target
* A separate project remains right for an agent needing its own image, such as one adding Python and NautilusTrader (H23)
* Each agent is still deployed as its own AgentCore runtime — the strongest isolation available — whatever project it lives in
* Worth taking from `@aws/nx-plugin`: one workspace-wide image registry rather than one per agent, constructs exposing `grantInvokeAccess`, and a client factory with local and IAM-authenticated variants

### Consequences

* Good, because a new agent is a generator run rather than a folder copied from another consumer
* Good, because the image is built once for a group of agents instead of once per agent
* Bad, because nesting makes build granularity a matter of targets rather than project boundaries, and a careless target rebuilds every agent in the project
* Bad, because generators are code to maintain, and they lag the libraries they scaffold unless a consumer exercises them
