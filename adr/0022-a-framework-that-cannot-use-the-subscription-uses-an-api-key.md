---
status: accepted
date: 2026-10-22
decision-makers: Jeremy Jonas
---

# A framework that cannot use the subscription uses an API key

## Context and Problem Statement

AgentForge's premise is that authentication is the operator's subscription, with no pay-per-use key present (§REQ705). The `claude` framework meets it: the Claude Agent SDK takes the subscription's OAuth token. Strands Agents, the second framework ([ADR 0021](0021-an-agentic-project-chooses-its-framework.md)), cannot use the subscription. Its loop calls a model provider's API directly. How does a `strands` project authenticate, through which provider, and what bounds its spend?

## Considered Options

* **The Anthropic API directly, with an API key, bounded by the Console's monthly spend limit**
* **Amazon Bedrock, with the agent's IAM role**
* **A gateway in front of the provider** (LiteLLM), owning keys and budgets

## Decision Outcome

Chosen option: **the Anthropic API directly, with an API key, bounded by the Anthropic Console's monthly spend limit.** The operator chose it on 2026-10-22.

* **Bedrock is rejected** for its model-usage-limit approvals and its lag behind the Anthropic API. Parity with the API matters more than keeping credentials in IAM.
* **A gateway is deferred.** LiteLLM's budgets need a PostgreSQL database, which is more than a spend limit is worth today. If one is added later, it owns budgeting and request-level caching only; prompt caching stays the framework's, at block level.
* **§REQ705 is withdrawn and replaced by §REQ714:** each deployment authenticates to its model provider only with what it declares — the operator's subscription where the framework can use it, otherwise an API key, with spend bounded by the provider account's limit — and no credential is present that it did not declare.
* **The key is the framework's required secret,** `ANTHROPIC_API_KEY`, declared by the `strands` framework and passed and mapped exactly as `claude`'s OAuth token is. A `claude` project still never holds a key.
* **Reaching the spend limit is `BUDGET_EXHAUSTED`,** not retryable: the limit resets monthly, so the operator raises it rather than a workflow waiting a month.

### Consequences

* Good, because a `strands` project has full parity with the Anthropic API, and one key and one Console limit are all there is to operate.
* Good, because the subscription premise still holds wherever the framework can use it.
* Bad, because a `strands` project bills per use, and a runaway procedure spends up to the monthly limit before it is stopped.
* Bad, because the key sits in the task's environment, readable by the agent's shell, as the OAuth token is (§ODO005); the spend limit bounds the exposure.
