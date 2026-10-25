# Serving, testing, deploying

Reference: [ARCHITECTURE §7](../../../../docs/ARCHITECTURE.md#7-agentic-projects-images-and-delivery) for images, targets and delivery, the [package README](../../../../libs/agentforge/README.md#the-nx-plugin) for what is maintained, and the root README's [known limits](../../../../README.md#known-limits). Worked examples: [`smoke-coverage`](../../../../packages/examples/smoke-coverage/project.json) and [`golden-kata-infra`](../../../../packages/examples/golden-kata-infra/src/stacks/application-stack.ts); on `strands`, [`research-brief-infra`](../../../../packages/examples/research-brief-infra/src/stacks/application-stack.ts).

## Targets

A generated agentic project has these maintained targets. Nx owns their order, so run the one you need and it builds what it depends on.

| Target | Does |
|---|---|
| `lock`, `lock-<agent>` | Writes a layer's `bun.lock`, for the whole container workspace up to it. Commit it |
| `image`, `image-<agent>` | Builds the project's image and each agent's, each `FROM` the one below |
| `serve-<agent>` | Runs the agent's container locally against the local store, continuous |
| `local-store`, `local-store-stop` | Starts the store every project on the machine shares (DynamoDB Local, SeaweedFS's S3, named volumes), or stops it keeping its data |
| `assemble` | Builds every agent's image, for the shared constructs' deploy |
| `seed-repository` | Seeds a git filesystem's host repository from its `https://` remote and declares it for every project's serve (below). On agentic and workflow projects alike, with the same effect from each |

Run `nx sync` after changing an agent, a connection or AgentForge's version. `nx sync:check` fails while a maintained file differs. Right after a generator, Nx's daemon can sync against a stale project graph; if `sync:check` still fails after `nx sync`, run it again with `NX_DAEMON=false`. A dependency an image needs goes in its layer's `package.json`, followed by `lock`.

**Extending an image with system packages** (Python, a native library), and Claude's user scope (below), are the reasons to detach a layer's `Dockerfile`. The image is Debian (glibc). Install with `apt-get` as `USER root`, return to `USER bun`, put a Python venv on `PATH` with `ENV`, and do it before the layer's own `COPY` lines. Follow the [package README](../../../../libs/agentforge/README.md#detaching) and `smoke-coverage`'s [base layer](../../../../packages/examples/smoke-coverage/base/Dockerfile). **A host project** (the workspace's own Python package, say) reaches a layer through a named build context: detach the layer's image target and `Dockerfile`, add the project's build to the target's `dependsOn` and its output to `buildContexts`, and `COPY --from=<name>` in the `Dockerfile` ([package README](../../../../libs/agentforge/README.md#detaching)).

**Claude's user scope is the base image's.** A plugin, such as a language server's, or a user setting goes into `~/.claude` in the base layer's detached `Dockerfile`: as `USER bun`, run the CLI the Agent SDK brings with `plugin marketplace add` and `plugin install <plugin>@<marketplace> --scope user`. The base options' `user` setting source loads it, and a run resumed from the store sees it as a fresh run does. Follow the [package README](../../../../libs/agentforge/README.md#detaching) and `smoke-coverage`'s [base layer](../../../../packages/examples/smoke-coverage/base/Dockerfile).

## Credentials belong to the target that uses them

Nx loads `.env.<configuration>` and `.env.<configuration>.local` into a target run with that configuration. Never put a credential in `.env.local`, which Nx loads into every task. Pass a secret to a container by name (`-e NAME`), never by value.

| Target | File | Holds |
|---|---|---|
| `serve-<agent>` (configuration `serve`) | `.env.serve.local`, ignored | The framework's secrets (`claude`: `CLAUDE_CODE_OAUTH_TOKEN`; `strands`: `ANTHROPIC_API_KEY`) and every secret the layers' `secrets.ts` require |
| a workflow project's `serve` | `.env.serve.local`, ignored | The project's secrets; `serve:hybrid` adds `.env.hybrid.local`, with `AGENTFORGE_AGENTS=runtime-config:<applicationId>` and AWS credentials. Never `TEMPORAL_API_KEY` against the local server |
| an infra project's `deploy`, `destroy` (configuration `cdk`) | `.env.cdk`, the operator's | `AWS_PROFILE` for the operator; the stage pins account and region |
| `test` | none | Unit tests reach nothing external |

On AgentCore, each secret is a Secrets Manager secret the operator creates, mapped to its variable in the agent's construct (`agents: { writer: { secrets: { CLAUDE_CODE_OAUTH_TOKEN: secret } } }`). A secret a layer declares and nothing maps fails to compile.

**One environment may hold both credentials.** While `CLAUDE_CODE_OAUTH_TOKEN` is set, a `claude` run's CLI is given no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, which it would otherwise use instead of the subscription, and a procedure that sets its own value for either in its `env` is refused.

**A `strands` project bills per use.** Its key is bounded by the Anthropic Console's monthly spend limit, which the operator sets. A run that reaches it, or the tier's spend cap, fails `BUDGET_EXHAUSTED`, not retryable: raise the limit, then retry the task. A rate limit below it is `USAGE_LIMITED`, with `retryAfter`, and a 5xx `PROVIDER_TRANSIENT`; both retryable. A procedure's own `limits` bound one run, and reaching one is also `BUDGET_EXHAUSTED`.

## Testing

| Tier | Where | Against |
|---|---|---|
| `test` | Colocated `*.test.ts` | Nothing external. A procedure's own logic; workflows with stubbed activities |
| `e2e` | `<project>/e2e/<place>/` | The whole path: the project client, the agent's image, a real model. `local` serves first; `agentcore` deploys first |

An e2e drives the agent only through the project client, the way a caller does, and asserts what holds whichever way the model words its answer. See `golden-kata`'s [suite](../../../../packages/examples/golden-kata/e2e/golden-kata.suite.ts), run by `local/` and `agentcore/`.

## Deploying

An infra project (`@aws/nx-plugin`'s `ts#infra`) instantiates each agentic project's construct from the shared constructs package, under the project's name:

```ts
import { GoldenKata } from '@<scope>/common-constructs';
const goldenKata = new GoldenKata(this, 'GoldenKata', {
  agents: { writer: { secrets }, grader: { secrets } },
  // removalPolicy (RETAIN), sessionRetention (forever) and sessionArchiveAfter (90 days to Glacier IR) are the project's, for all its agents
});
goldenKata.grantInvoke(callerRole);
```

- One set of resources per project: a task table, a session bucket, a dashboard and a readiness probe. `cdk deploy` returns only once every agent serves.
- An S3 filesystem's bucket is its own construct, `S3FilesystemBucket`, passed to an agent as `filesystems: { name: bucket }`.
- A workflow project deploys as a `TemporalWorker` ECS service on Temporal Cloud, through its own construct, which requires each connected project's construct.
- Deploy with the operator's credentials (`.env.cdk`). A project and its callers take a new AgentForge version in one deploy.

## Git repositories

A git filesystem's `repository` is a name the deployment declares in `AGENTFORGE_FILESYSTEM_REPOSITORIES`, a JSON object of name to location: `https://` with no credential in it, or, to `serve`, a host directory. On AgentCore, the agent's construct takes `repositories: { journal: 'https://github.com/o/journal.git' }` and the token in `secrets`.

Locally, `serve` bind-mounts a host directory into the container and serves it as `file://`, so a local run never reaches the remote or needs its token. A relative location is the workspace's.

- **A repository with a remote**: seed its host repository first, from any agentic or workflow project:

  ```bash
  nx run <project>:seed-repository --repository=strategies --remote=https://github.com/<owner>/strategies.git
  ```

  It bare-clones the remote with the host's own git credentials (a credential helper, `gh`) into `--location`, `.agentforge/repositories/<name>.git` by default and kept out of version control, then declares it in the workspace root's `.env.serve` (relative location, commit it) or `.env.serve.local` (absolute). Every agentic project's `serve-<agent>` and the workflow project's `serve` read it there. `--readingClone=<path>` makes a working clone whose `origin` is the host repository, for reading what agents committed. It never pushes. Run again, it changes nothing. It adopts an existing bare clone of the same remote, and fails, naming the path, on a working clone, a bare repository of another remote, or a project's own env file that would mask the workspace's declaration. Syncing the host repository with its remote is the operator's, by hand, through its `origin`.
- **A repository with no remote**: declare it yourself in `.env.serve` (`AGENTFORGE_FILESYSTEM_REPOSITORIES={"journal":".agentforge/repositories/journal.git"}`). `serve` creates it empty on `main` and logs that it did. Never let `serve` create one that has a remote: its history is unrelated to the remote's, and seeding it later fails.
- **StrategyFoundry's existing bare clone** is adopted by passing its path as `--location` and the remote it was cloned from, with `--readingClone` at its existing working clone.

## Known limits

Read the root README's [known limits](../../../../README.md#known-limits) before relying on resume, files across containers, a shared prefix, deletes, Bash, or transcript retention. The ones that most often shape a procedure:

- A resumed session doesn't bring its files to a new container. Only what a filesystem pushed is there.
- Two tasks on one S3 prefix at once overwrite each other. Keep a prefix to one task at a time.
- Locally, tasks, transcripts, filesystems and memory persist in the local store, across containers and restarts. Declare a filesystem's buckets to `serve` in the project's committed `.env.serve`: `AGENTFORGE_FILESYSTEM_BUCKETS={"notebook":"my-notebook"}`. A local worker reads the store's S3 at `http://127.0.0.1:8333`, path-style.
- Two tasks pushing to one git branch at once both land when they change different files. One changing a file the other changed since its pull fails `FILESYSTEM_UNSYNCED`, retryable.
