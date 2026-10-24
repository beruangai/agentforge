# Spec Delta

## Purpose

A filesystem whose store is one branch of a git repository: it mounts a subtree of that branch, and persists the write scope's changes as commits, merged onto what others pushed and refused where two writers changed one file.

## ADDED Requirements

### Requirement: A git filesystem mounts a subtree of one branch
A git filesystem SHALL take its store to be one branch of one repository, `main` unless it declares another. Its remote root and subpath SHALL name a directory in that branch's tree (`/` for the repository's root), and its mount SHALL hold that directory's files at its local path as the mount's root, as they are at the branch's tip when it pulls (see [filesystem-lifecycle](../filesystem-lifecycle/spec.md)). A directory the branch does not have SHALL mount empty. Over a kept copy (see [filesystem-lifecycle](../filesystem-lifecycle/spec.md)), where the branch and the copy both changed a file since the copy's base, the pull SHALL take the branch's version. The repository SHALL be named in the filesystem's options and resolved to a location from the deployment's declared repositories. A name the deployment does not declare SHALL fail the task with cause `EXECUTION_ERROR` before anything is mounted.

#### Scenario: A subtree as the mount's root
- **WHEN** a git filesystem with local root `/workspace/vault` and remote root `/projects` resolves the subpath `alpha`, and the branch holds `projects/alpha/plan.md`
- **THEN** the handler finds `/workspace/vault/alpha/plan.md`, and nothing of the branch outside `projects/alpha`

#### Scenario: A directory not yet in the branch
- **WHEN** a git filesystem's resolved directory does not exist on the branch
- **THEN** it mounts empty, and its first push creates it

#### Scenario: Both changed a file in a kept copy
- **WHEN** a kept git copy holds a local change to `alpha/plan.md`, and the branch changed `alpha/plan.md` since the copy's base
- **THEN** the next task's mount holds the branch's `alpha/plan.md`, and the discarded local change is logged

#### Scenario: An undeclared repository
- **WHEN** a git filesystem names a repository the deployment does not declare
- **THEN** the task fails `EXECUTION_ERROR`, naming the repository and the declared ones, before anything is mounted

### Requirement: A push is one commit of the write scope, merged onto the remote tip
A git filesystem's push SHALL record, as one commit on its branch, every file in its write scope that was added or changed since its base, the commit it last pulled or pushed, and no file outside the write scope or excluded. A push with nothing to record SHALL succeed and add no commit. A commit SHALL carry the filesystem's message, its author, and trailers naming the task id, the idempotency key and the attempt. When the branch has moved since the base, the push SHALL merge its commit onto the branch's tip and push again, a bounded number of times. Only a push the remote accepted SHALL count as verified. After a push, the mount's base SHALL be the commit pushed, and its files SHALL include what the merge brought in.

#### Scenario: Only the write scope is committed
- **WHEN** a git filesystem that may write `notes/**` finds `notes/today.md` changed and `index.md` changed at push
- **THEN** one commit records `notes/today.md`, and `index.md` stays a local change

#### Scenario: Another writer pushed elsewhere on the branch
- **WHEN** a task pushes after another writer has pushed a change to a different file on the same branch
- **THEN** both changes are on the branch, the task's commit following the other's, and the push succeeds

#### Scenario: Nothing to push
- **WHEN** a git filesystem's write scope has no change at push
- **THEN** the push succeeds and the branch is unchanged

#### Scenario: A commit names its task
- **WHEN** a task's push records a commit
- **THEN** the commit's trailers carry the task's id, idempotency key and attempt

### Requirement: Two writers' changes to one file are refused
A git filesystem's push SHALL fail with cause `FILESYSTEM_UNSYNCED`, retryable, naming the files, when a file it would record was also changed on the branch since its base, and SHALL publish nothing in that case. A push SHALL never overwrite or textually merge another writer's change to a file.

#### Scenario: The same file changed by two writers
- **WHEN** a task changes `alpha/plan.md` and, before it pushes, another writer pushes a change to `alpha/plan.md`
- **THEN** the task's push fails `FILESYSTEM_UNSYNCED` naming `alpha/plan.md`, and the branch keeps the other writer's version

### Requirement: Deletes are relative to the base, and off by default
A git filesystem's push SHALL record a file in its write scope that was removed locally as deleted only when the filesystem enables deletes. It SHALL never delete a file it did not have at its base. Enabling deletes SHALL require a remote root or subpath, as for every kind that deletes.

#### Scenario: Deletes off
- **WHEN** a task removes `alpha/draft.md` from a git filesystem that does not enable deletes, and pushes
- **THEN** the branch still has `alpha/draft.md`

#### Scenario: Deletes on
- **WHEN** a task removes `alpha/draft.md` from a git filesystem that enables deletes, and pushes
- **THEN** the branch no longer has `alpha/draft.md`

#### Scenario: A file another writer added survives a delete
- **WHEN** a task on a git filesystem that enables deletes pushes after another writer added `alpha/new.md`
- **THEN** the branch has `alpha/new.md`

### Requirement: A git filesystem has no timer checkpoints
A git filesystem SHALL be refused, when it is declared, if it declares checkpoints.

#### Scenario: Checkpoints declared
- **WHEN** a git filesystem is declared with checkpoints
- **THEN** declaring it throws, naming the option

### Requirement: The agent may push a git mount
When a git filesystem pushes on `TASK_STATE_FAILED`, its mount SHALL offer a push the agent may call while the task runs, with a message of its own. The push SHALL record and publish the write scope as a push at unmount does, one at a time with every other push of the mount, and SHALL report what it recorded or why it failed to its caller, without ending the task. A git filesystem that pushes only on `TASK_STATE_COMPLETED` SHALL offer none, since a push mid-task publishes before the outcome is known.

#### Scenario: The agent publishes partial work
- **WHEN** an agent calls its git mount's push with a message, midway through a task whose filesystem pushes on `TASK_STATE_FAILED`
- **THEN** the branch has a commit with that message recording the write scope's changes so far, and the task continues

#### Scenario: A push that fails mid-task
- **WHEN** an agent's push is refused because another writer changed the same file
- **THEN** the agent is told which files, and the task continues

#### Scenario: Completed-only pushes offer none
- **WHEN** a git filesystem pushes only on `TASK_STATE_COMPLETED`
- **THEN** its mount offers no push

### Requirement: The remote's credential is absent from the agent's environment and every output
A git filesystem SHALL authenticate to a remote that requires it with a token from a declared secret it names. It SHALL remove that secret from the task's environment before any agent run, so no agent run inherits it, nor any command started with the task's current environment, and SHALL give the token to its own git operations alone. A command a handler starts with the process's startup environment instead is outside this guarantee. The token SHALL never be written to disk, to a command line, or into any cause, log line or record. A remote that requires a token SHALL fail the task with cause `EXECUTION_ERROR` before anything is mounted when the secret is unset. A repository on the container's own disk SHALL need none, so a local run against one needs no token set. A remote that refuses the token SHALL fail the task with cause `CREDENTIAL_EXPIRED`, naming the secret, never a retryable cause. The task process's initial environment, which the operating system keeps, is outside this guarantee, as it is for every secret.

#### Scenario: The agent's environment has no token
- **WHEN** a task mounts a git filesystem whose token is a declared secret, and its agent's shell lists its environment
- **THEN** the token is not there

#### Scenario: A failure names no credential
- **WHEN** a push to a remote fails and the remote's error echoes the request
- **THEN** the task's cause names the failure without the token

#### Scenario: A token the remote refuses
- **WHEN** a git filesystem's remote rejects its token as unauthorized
- **THEN** the task fails `CREDENTIAL_EXPIRED`, naming the secret, not retryable, and the cause carries no token

#### Scenario: A local repository needs no token
- **WHEN** a git filesystem names a repository on the container's own disk, and its token's secret is unset
- **THEN** it mounts and pushes

#### Scenario: A remote that needs a token, unset
- **WHEN** a git filesystem's remote needs a token and the secret it names is unset
- **THEN** the task fails `EXECUTION_ERROR`, naming the secret, before anything is mounted
