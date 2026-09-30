# golden-kata-infra

AgentForge's test deployment of [golden-kata](../golden-kata/README.md), generated with `@aws/nx-plugin`'s `ts#infra` and adapted in place:

```bash
nx g @aws/nx-plugin:ts#infra golden-kata-infra --directory packages/examples
```

Its stack declares `GoldenKata` — both agents, each its own AgentCore runtime registered in the stage's runtime configuration, with the subscription token from the `agentforge/claude-code-oauth-token` secret the operator creates — and a `Caller` role granted exactly those agents and the configuration read, the stand-in for a consumer's Temporal worker. The stage is `agentforge-example-golden-kata`, in `us-east-2`, removed on `destroy`.

```bash
nx run @beruangai/golden-kata-infra:deploy
```

```bash
nx run @beruangai/golden-kata-infra:destroy
```

`synth`, `deploy` and `destroy` run with the operator's credentials, from `.env.cdk` at the workspace root through their `cdk` configuration; the stage pins its account and `us-east-2` in `src/main.ts`, so the credentials only authorise and can never redirect it. `destroy` first asks for the stage's name, typed, and refuses without a terminal to ask on. `deploy` builds the images first (`^assemble`), gates on `checkov`, deploys the checked `cdk.out`, and writes its outputs, among them `RuntimeConfigApplicationId`, to `dist/packages/examples/golden-kata-infra/deploy/outputs.json`. `destroy` empties the versioned session buckets first. `test` asserts the caller's grant against the synthesized template.
