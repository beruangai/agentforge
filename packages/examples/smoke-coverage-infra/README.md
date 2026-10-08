# smoke-coverage-infra

AgentForge's test deployment of [smoke-coverage](../smoke-coverage/README.md), generated with `@aws/nx-plugin`'s `ts#infra` and adapted in place as [golden-kata-infra](../golden-kata-infra/README.md) is:

```bash
nx g @aws/nx-plugin:ts#infra smoke-coverage-infra --directory packages/examples
```

Its stack declares `SmokeCoverage` — hello-agent as its own AgentCore runtime registered in the stage's runtime configuration, with the subscription token from the `agentforge/claude-code-oauth-token` secret the operator creates — and the `notebook` filesystem's `S3FilesystemBucket`. It outputs what the smoke suite needs beyond the runtime configuration: the runtime's ARN, to stop a container, and the project's session bucket (`SessionBucketName`), to find a transcript under `hello-agent/`. `destroy` empties it and the filesystem buckets first. The stage is `agentforge-example-smoke-coverage`, in `us-east-2`, removed on `destroy`.

```bash
nx run @beruangai/smoke-coverage-infra:deploy
```

```bash
nx run @beruangai/smoke-coverage-infra:destroy
```

`synth`, `deploy` and `destroy` run with the operator's credentials, from `.env.cdk` at the workspace root through their `cdk` configuration; the stage pins its account and `us-east-2` in `src/main.ts`. `destroy` first asks for the stage's name, typed, and refuses without a terminal to ask on; then it empties the session and notebook buckets. `deploy` builds the images first (`^assemble`), gates on `checkov`, and writes its outputs to `dist/packages/examples/smoke-coverage-infra/deploy/outputs.json`. It has no test tier: its stack only composes constructs whose own tests cover them.
