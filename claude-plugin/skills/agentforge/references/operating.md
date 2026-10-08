# Serving, testing, deploying

Reference: [ARCHITECTURE §7](../../../../docs/ARCHITECTURE.md#7-agentic-projects-images-and-delivery) for images, targets and delivery, the [package README](../../../../libs/agentforge/README.md#the-nx-plugin) for what is maintained, and the root README's [known limits](../../../../README.md#known-limits). Worked examples: [`smoke-coverage`](../../../../packages/examples/smoke-coverage/project.json) and [`golden-kata-infra`](../../../../packages/examples/golden-kata-infra/src/stacks/application-stack.ts).

## Targets

A generated agentic project has these maintained targets. Nx owns their order, so run the one you need and it builds what it depends on.

| Target | Does |
|---|---|
| `lock`, `lock-<agent>` | Writes a layer's `bun.lock`, for the whole container workspace up to it. Commit it |
| `image`, `image-<agent>` | Builds the project's image and each agent's, each `FROM` the one below |
| `serve-<agent>` | Runs the agent's container locally with DynamoDB Local, continuous |
| `assemble` | Builds every agent's image, for the shared constructs' deploy |

Run `nx sync` after changing an agent, a connection or AgentForge's version. `nx sync:check` fails while a maintained file differs. A dependency an image needs goes in its layer's `package.json`, followed by `lock`.

**Extending an image with system packages** (Python, a native library) is the one reason to detach a layer's `Dockerfile`. The image is Debian (glibc). Install with `apt-get` as `USER root`, return to `USER bun`, put a Python venv on `PATH` with `ENV`, and do it before the layer's own `COPY` lines. Follow the [package README](../../../../libs/agentforge/README.md#detaching) and `smoke-coverage`'s [base layer](../../../../packages/examples/smoke-coverage/base/Dockerfile).

## Credentials belong to the target that uses them

Nx loads `.env.<configuration>` and `.env.<configuration>.local` into a target run with that configuration. Never put a credential in `.env.local`, which Nx loads into every task. Pass a secret to a container by name (`-e NAME`), never by value.

| Target | File | Holds |
|---|---|---|
| `serve-<agent>` (configuration `serve`) | `.env.serve.local`, ignored | `CLAUDE_CODE_OAUTH_TOKEN` and every secret the layers' `secrets.ts` require |
| a workflow project's `serve` | `.env.serve.local`, ignored | The project's secrets; `serve:hybrid` adds `.env.hybrid.local`, with `AGENTFORGE_AGENTS=runtime-config:<applicationId>` and AWS credentials. Never `TEMPORAL_API_KEY` against the local server |
| an infra project's `deploy`, `destroy` (configuration `cdk`) | `.env.cdk`, the operator's | `AWS_PROFILE` for the operator; the stage pins account and region |
| `test` | none | Unit tests reach nothing external |

On AgentCore, each secret is a Secrets Manager secret the operator creates, mapped to its variable in the agent's construct (`agents: { writer: { secrets: { CLAUDE_CODE_OAUTH_TOKEN: secret } } }`). A secret a layer declares and nothing maps fails to compile.

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
  // removalPolicy (RETAIN by default) and sessionRetention (30 days) are the project's, for all its agents
});
goldenKata.grantInvoke(callerRole);
```

- One set of resources per project: a task table, a session bucket, a dashboard and a readiness probe. `cdk deploy` returns only once every agent serves.
- An S3 filesystem's bucket is its own construct, `S3FilesystemBucket`, passed to an agent as `filesystems: { name: bucket }`.
- A workflow project deploys as a `TemporalWorker` ECS service on Temporal Cloud, through its own construct, which requires each connected project's construct.
- Deploy with the operator's credentials (`.env.cdk`). A project and its callers take a new AgentForge version in one deploy.

## Known limits

Read the root README's [known limits](../../../../README.md#known-limits) before relying on resume, files across containers, a shared prefix, deletes, Bash, or transcript retention. The ones that most often shape a procedure:

- A resumed session doesn't bring its files to a new container. Only what a filesystem pushed is there.
- Two tasks on one S3 prefix at once overwrite each other. Keep a prefix to one task at a time.
- Locally, sessions live in the container and end with it.
