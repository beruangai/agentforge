# golden-kata-infra

AgentForge's test deployment of [golden-kata](../golden-kata/README.md), generated with `@aws/nx-plugin`'s `ts#infra` and adapted in place:

```bash
nx g @aws/nx-plugin:ts#infra golden-kata-infra --directory packages/examples
```

Its stack declares `GoldenKata` — both agents, each its own AgentCore runtime registered in the stage's runtime configuration, with the subscription token from the `agentforge/claude-code-oauth-token` secret the operator creates — and `GoldenKataWorkflows`, [golden-kata-workflows](../golden-kata-workflows)' worker: an ECS Fargate service in a VPC of public subnets with no NAT gateway (it only calls out), polling the operator's Temporal Cloud namespace `beruangai-agentforge.vwhld` with the API key from the `agentforge/temporal-api-key` secret the operator creates, its task role granted exactly those agents and the configuration read. Both secrets live outside the stack, so `destroy` leaves them. The stage is `agentforge-example-golden-kata`, in `us-east-2`, removed on `destroy`.

```bash
nx run @beruangai/golden-kata-infra:deploy
```

```bash
nx run @beruangai/golden-kata-infra:destroy
```

`synth`, `deploy` and `destroy` run with the operator's credentials, from `.env.cdk` at the workspace root through their `cdk` configuration; the stage pins its account and `us-east-2` in `src/main.ts`, so the credentials only authorise and can never redirect it. `destroy` first asks for the stage's name, typed, and refuses without a terminal to ask on. `deploy` builds the images first (`^assemble`), gates on `checkov`, deploys the checked `cdk.out`, and writes its outputs, among them `RuntimeConfigApplicationId`, to `dist/packages/examples/golden-kata-infra/deploy/outputs.json`. `destroy` empties the versioned session buckets first. `test` asserts the worker's grants and its Temporal connection against the synthesized template. `synth` needs the worker's bundle, which `^assemble` builds.
