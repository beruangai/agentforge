---
status: proposed
date: 2026-10-14
decision-makers: Jeremy Jonas
---

# Local state lives in a shared local store

## Context and Problem Statement

A served agent kept its tasks in an in-memory DynamoDB Local and its transcripts and filesystems in its container, so a restart lost them and a filesystem could not be used locally at all. StrategyFoundry is local-first: its sessions run for months and its artifact store outlives every task, so local runs need §REQ402 and filesystems as deployed runs have them, through one code path (§REQ701) and APIs, not mounts ([ADR 0011](0011-state-persists-through-apis-not-mounts.md)). This was tabled as §ODO009 until a consumer needed it.

## Considered Options

* **DynamoDB Local and SeaweedFS**, one docker-compose stack every project on the machine shares, in named volumes
* **LocalStack**, one container for DynamoDB and S3
* **MinIO** for S3 beside DynamoDB Local
* **Host directories** in place of S3

## Decision Outcome

Chosen option: **DynamoDB Local and SeaweedFS in a shared compose stack**, run like the local Temporal server: the `local-store` target starts it unless running, and `serve` joins its network, creating the project's table and buckets there. `AGENTFORGE_S3_ENDPOINT` points every S3 client and `s7cmd` at it, path-style; deployed, it is unset. Checked on 2026-10-14 ([research](../docs/research/local-store.md)).

### Consequences

* Good, because procedures, the harness and the session store run the code they run deployed, against the S3 and DynamoDB APIs
* Good, because state survives a container, a restart of the store, and a rebuilt image, and a local worker reads the same S3 on the host
* Good, because neither needs an account, a token or a licence for commercial use
* Bad, because a local S3 server is not S3: a behaviour AgentForge relies on is checked against it by the local e2e, not assumed
* Bad, because one store holds every project's local state, separated by table and bucket names, not by credentials

## Pros and Cons of the Options

### LocalStack

* Good, because one container emulates both services, and more
* Bad, because since 2026-03-23 it needs an account and an auth token, its free plan is for non-commercial use, and persistence is in its paid plans only

### MinIO

* Bad, because its community edition stopped publishing images in October 2025 and its repository is archived

### Host directories

* Bad, because they are a second code path for every filesystem and the session store, which ADR 0011 rules out
