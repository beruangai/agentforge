# AgentCore integration tests

What AgentForge relies on from AgentCore and AgentCore does not document: a busy container still receiving `SendMessage`, `GetTask` and `CancelTask`; an invocation during CREATING blocking rather than returning 409; SIGTERM at once on `StopRuntimeSession`, the ~60-second kill after it, and a working network inside it; and A2A 1.0 only, through AgentCore. Any of them can move with a platform change and nothing else would notice. What AgentCore documents — one microVM per session, the header allowlist — is trusted, not re-tested (`.claude/rules/testing.md`). The findings, with their dates, are in [`docs/research/agentcore-runtime-observed.md`](../../../../../docs/research/agentcore-runtime-observed.md); each test asserts one of them.

No model is called. The container in `__fixtures__/server.ts` is an A2A server whose "task" is a timer — the thing AgentCore's behaviour is observed through, not AgentForge's server.

Every runtime runs on **platform version V2**, as AgentForge does: every container is restored from one snapshot taken at the first healthy `/ping` ([`agentcore-runtime.md`](../../../../../docs/research/agentcore-runtime.md) §Platform version V2). So the container mints nothing at startup — its container id is minted on its first invocation, after the restore — or every container would report the same one. The access probe alone stays on the default platform version; `__fixtures__/access.ts` says why.

## Running

From the repository root, `nx run @beruangai/agentforge:integ`. Nx loads `.env.integ` — `AWS_PROFILE=agentforge--test-integ`, `AWS_REGION=us-east-2` — into the `integ` task and no other, so no other task holds these credentials, and nothing anywhere falls back to a `default` profile. That profile assumes the `AgentForgeTestInteg` role from your `agentforge` SSO session, so sign in with `aws sso login --profile agentforge`; if the session has lapsed the run fails on credentials rather than working around it. The code reads the account from STS; the policy documents name it, `913756569129`, because a policy is only well formed with its account and region written out.

**Tests run in `us-east-2`; prod is `us-west-2`.** The test role reaches nothing in any other region: every regional resource it names carries `us-east-2` in its ARN, and every call that cannot be scoped to a resource is conditioned on `aws:RequestedRegion`.

The tests also need Docker with `buildx`, `bun`, and `docker-credential-ecr-login` ([amazon-ecr-credential-helper](https://github.com/awslabs/amazon-ecr-credential-helper); `brew install docker-credential-helper-ecr`) on `PATH`: each file bundles the fixture server with `bun build --target=bun`, builds it for `linux/arm64` on `oven/bun:1.4.0-alpine` pinned by digest, and pushes it to ECR. There is no `docker login`: the helper fetches an ECR token from the task's `AWS_PROFILE` at each push and caches nothing, so no registry credential lands in the keychain.

Before provisioning anything, every file runs the access check in `__fixtures__/access.ts`. It walks each permission the tests need to the end of the path — ending in a real `CreateAgentRuntime` against a nonexistent image, which fails on the image when IAM is right and on authorization when it is not — and fails naming exactly what is missing. It exists because on 2026-09-22 a probe checked `iam:CreateRole`, found it denied, and asked for a role, when the permission actually blocking `CreateAgentRuntime` was `iam:PassRole`.

## What each file creates, and removes

Every file provisions its own resources in `beforeAll` and deletes them in `afterAll`, all tagged `agentforge:integ=true`: an ECR repository `agentforge/integ-<purpose>-<suffix>`, a runtime `agentforge_integ_<purpose>_<suffix>`, its log groups, and — for `outcome-inside-grace.test.ts` — a DynamoDB table `agentforge-integ-outcome-<purpose>-<suffix>`.

Runtimes are slow at both ends. On V2 a create takes minutes before READY while the snapshot is prepared, and a runtime sat in DELETING for about five minutes on V1. Teardown waits out a runtime still CREATING — deleting it then is a `ConflictException`, which would leak it — and then until it and its workload identity are gone, rather than returning on the call. Expect each file to take ten minutes or more beyond its tests. The files run in parallel with one another (`vitest.integ.mts`), so the whole directory takes about as long as its slowest file. A teardown that cannot delete something fails the run and names what is left. To check by tag afterwards:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=agentforge:integ,Values=true \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

## What an admin must create once

Two things, both needing an admin identity. They are prerequisites, not tests; nothing here creates or deletes them. Every policy document here is attached as it is — account `913756569129` and region `us-east-2` are written into each. Run from the repository root, as an admin, in that account:

**1. The `AgentForgeTestInteg` role**, in this account, with trust policy [`../test-role-trust-policy.json`](../test-role-trust-policy.json) and inline policy [`../test-role-permissions-policy.json`](../test-role-permissions-policy.json).

- **Who may assume it:** only the SSO role Identity Center provisions for `PowerUserAccess` in this account, matched by `aws:PrincipalArn` because that role's path is generated.
- **What it may do:** what the AgentCore and `s7cmd` sync tests call, and nothing outside `us-east-2`. AgentCore is granted whole within `us-east-2`, because that region holds nothing but tests, and `CreateAgentRuntime` also authorizes the endpoint, tags and workload identity it creates against resources that have no name yet. ECR, DynamoDB, logs and S3 are further scoped to the names the tests create (`agentforge/integ-*`, `agentforge-integ-*`, `agentforge_integ_*`). It includes `iam:PassRole` on the execution role below, conditioned on `iam:PassedToService: bedrock-agentcore.amazonaws.com`; without it `CreateAgentRuntime` is refused no matter what the role allows.

It is a role in this account rather than an Identity Center permission set because its policy only means anything here: it names this account and region, and a change is one `put-role-policy`, with no management-account step.

```bash
aws iam create-role --role-name AgentForgeTestInteg \
  --assume-role-policy-document file://packages/agentforge/integ/aws/test-role-trust-policy.json
aws iam put-role-policy --role-name AgentForgeTestInteg \
  --policy-name agentforge-integ-test \
  --policy-document file://packages/agentforge/integ/aws/test-role-permissions-policy.json
```

and a profile for it in `~/.aws/config`, reached from the `agentforge` SSO profile:

```ini
[profile agentforge--test-integ]
source_profile = agentforge
role_arn = arn:aws:iam::913756569129:role/AgentForgeTestInteg
region = us-east-2
```

`.env.integ` names the profile. After editing the policy file, re-run `put-role-policy`. A chained role's session lasts at most an hour; the SDKs assume it again when it lapses.

The policy is scoped by region and name rather than pared to the last action: tagging, image deletion and what AgentCore creates alongside a runtime are granted outright rather than discovered one denial at a time, since each denial costs an admin round-trip. The access check above names anything still missing.

**2. The execution role AgentCore assumes** — trusted by `bedrock-agentcore.amazonaws.com` for this account and `us-east-2` only; it pulls from ECR, writes the runtime's logs, and may touch DynamoDB tables and S3 buckets named `agentforge-integ-*`:

```bash
FIXTURES=packages/agentforge/integ/aws/agentcore/__fixtures__
aws iam create-role --role-name agentforge-integ-agentcore-execution \
  --tags Key=agentforge:integ,Value=true \
  --assume-role-policy-document "file://$FIXTURES/execution-role-trust-policy.json"

aws iam put-role-policy --role-name agentforge-integ-agentcore-execution \
  --policy-name agentforge-integ-execution \
  --policy-document "file://$FIXTURES/execution-role-permissions-policy.json"
```


### Replaced

- **The tests no longer run as the `agentforge` profile.** It is only the source the test role is assumed from. Drop the `PassTheIntegExecutionRoleToAgentCoreOnly` statement from its permission set, if it was added there.
- **The `AgentForgeTestInteg` permission set**, which this role replaces: remove its account assignment, then the permission set.
- **The spikes' role**, `agentforge-spike-agentcore-execution`, if it still exists:

  ```bash
  aws iam delete-role-policy --role-name agentforge-spike-agentcore-execution \
    --policy-name agentforge-spike-execution
  aws iam delete-role --role-name agentforge-spike-agentcore-execution
  ```

### Removing them

```bash
aws iam delete-role-policy --role-name agentforge-integ-agentcore-execution \
  --policy-name agentforge-integ-execution
aws iam delete-role --role-name agentforge-integ-agentcore-execution
```

```bash
aws iam delete-role-policy --role-name AgentForgeTestInteg --policy-name agentforge-integ-test
aws iam delete-role --role-name AgentForgeTestInteg
```
