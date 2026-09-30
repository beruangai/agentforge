# infra-workflow-worker Specification

## Purpose
Deploys a workflow project's worker as a long-running service polling the consumer's Temporal Cloud namespace, which polls once the deploy returns, reads only the secrets it declares, and accepts no inbound connection.

## Requirements

### Requirement: One construct deploys a worker that polls when the deploy returns
A consumer SHALL deploy a worker with one construct, as a long-running service on the network, cluster, size and count the consumer chooses, polling the Temporal Cloud namespace the consumer names at the address the consumer gives. A deploy SHALL return only once the worker is running, and SHALL fail when the worker cannot start. The construct SHALL refuse a value it sets itself, such as the worker's image or its Temporal connection variables.

#### Scenario: A deploy that returns polls
- **WHEN** a consumer deploys a worker and starts one of its workflows on its task queue in the namespace
- **THEN** the deployed worker runs the workflow to its output

#### Scenario: A worker that cannot start
- **WHEN** the worker cannot connect — its API key refused, or a declared secret unset
- **THEN** the deploy fails

#### Scenario: What the construct owns
- **WHEN** a consumer sets the worker's image, or its Temporal address, namespace or API key as a plain value
- **THEN** the construct refuses it

### Requirement: A worker has least privilege
A deployed worker SHALL read only the secrets it declares, the Temporal API key among them, and SHALL be granted nothing else by the construct but what it is given. It SHALL need no inbound network access.

#### Scenario: Declared secrets alone
- **WHEN** a worker declares secrets
- **THEN** it can read those secrets and no other, each in the variable it names

#### Scenario: No API key
- **WHEN** a consumer declares a worker's secrets without the Temporal API key
- **THEN** the construct refuses it

#### Scenario: No inbound access
- **WHEN** a worker is deployed
- **THEN** nothing may connect to it, and it still polls its namespace

### Requirement: A replaced worker drains before it is stopped
A worker being replaced or stopped SHALL be given longer to stop than the grace its running activities have to finish, so it is never killed inside that grace.

#### Scenario: A redeploy mid-activity
- **WHEN** a worker is redeployed while an activity waits on an agent's task
- **THEN** the old worker exits inside its stop window, the retry attaches to the same task on the new worker, and the workflow completes
