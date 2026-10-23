# research-brief-infra

AgentForge's test deployment of [research-brief](../research-brief/README.md), copied from [smoke-coverage-infra](../smoke-coverage-infra/README.md) and adapted in place.

Its stack declares `ResearchBrief` — the briefer as its own AgentCore runtime registered in the stage's runtime configuration, with `ANTHROPIC_API_KEY` from the `agentforge/anthropic-api-key` secret the operator creates — and the `documents` filesystem's `S3FilesystemBucket`. It outputs the documents bucket (`DocumentsBucketName`), where the suite uploads a corpus under `corpora/`, which the test role may write, and the project's session bucket (`SessionBucketName`), where the glossary is kept under `briefer/memory/`. The stage is `agentforge-example-research-brief`, in `us-east-2`, removed on `destroy`.

```bash
nx run @beruangai/research-brief-infra:deploy
```

```bash
nx run @beruangai/research-brief-infra:destroy
```

`synth`, `deploy` and `destroy` run with the operator's credentials from `.env.cdk`, as smoke-coverage-infra's do; `destroy` asks for the stage's name, typed, then empties the session and documents buckets.
