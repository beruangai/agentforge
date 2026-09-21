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

* **Generators, constructs and the deploy path are all part of it.** The generators are not scaffolding convenience: a **sync generator** is how a consumer's wiring stays correct as AgentForge iterates, and without one every change becomes ad-hoc patching in two repositories. `@aws/nx-plugin` already does this, so AgentForge extends its conventions rather than starting over
* Nesting follows the image layering ([ADR 0008](0008-code-ships-in-the-image.md)): a project holds one package image and the agents that extend it, each agent keeping its own image, build target and deploy target, so a change rebuilds only the layer that contains it
* A separate project is right for an agent whose capabilities are unlike its neighbours', such as one adding Python and NautilusTrader (D28); it extends AgentForge's base image directly
* Each agent is still deployed as its own AgentCore runtime — the strongest isolation available — whatever project it lives in
* Worth taking from `@aws/nx-plugin`: one workspace-wide image registry rather than one per agent, constructs exposing `grantInvokeAccess`, and a client factory with local and IAM-authenticated variants

### Consequences

* Good, because an agent's infrastructure comes from reviewed constructs rather than a folder copied from another consumer, and a generator can follow once the shape is known
* Good, because the image is built once for a group of agents instead of once per agent
* Bad, because nesting makes build granularity a matter of targets rather than project boundaries, and a careless target rebuilds every agent in the project
* Bad, because generators are code to maintain and lag the libraries they scaffold unless a consumer exercises them — which the sync generator mitigates only if it is exercised on every release
