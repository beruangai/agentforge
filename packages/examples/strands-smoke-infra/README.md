# strands-smoke-infra

AgentForge's test deployment of [strands-smoke](../strands-smoke/README.md), copied from [smoke-coverage-infra](../smoke-coverage-infra/README.md) and adapted in place.

Its stack declares `StrandsSmoke` — hello-agent as its own AgentCore runtime registered in the stage's runtime configuration, with `ANTHROPIC_API_KEY` from the `agentforge/anthropic-api-key` secret the operator creates — and the `notebook` filesystem's `S3FilesystemBucket`. It outputs the image every task records, and the project's session bucket (`SessionBucketName`), where a session is kept under `hello-agent/session/`. The stage is `agentforge-example-strands-smoke`, in `us-east-2`, removed on `destroy`.

```bash
nx run @beruangai/strands-smoke-infra:deploy
```

```bash
nx run @beruangai/strands-smoke-infra:destroy
```

`synth`, `deploy` and `destroy` run with the operator's credentials from `.env.cdk`, as smoke-coverage-infra's do; `destroy` asks for the stage's name, typed, then empties the session and notebook buckets.
