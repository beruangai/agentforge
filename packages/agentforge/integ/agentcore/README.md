# AgentCore integration tests

AgentCore's contract, observed against a real runtime: the request header allowlist, the silent part strip, the ~60-second kill after `StopRuntimeSession`, one container per session, a busy container still receiving invocations, the lease. Any of them can move with a platform change and nothing else would notice. The findings, with their dates, are in [`docs/research/agentcore-runtime-observed.md`](../../../../docs/research/agentcore-runtime-observed.md); each test asserts one of them.

No model is called. The container in `__fixtures__/server.ts` is an A2A server whose "task" is a timer — the thing AgentCore's behaviour is observed through, not AgentForge's server.

## Running

From the repository root, `nx run @beruangai/agentforge:integ`. Nx loads `.env` (`AWS_PROFILE=agentforge`, `AWS_REGION=us-west-2`) into the task. The account is read from STS; nothing is hard-coded.

The tests also need Docker with `buildx` and `bun` on `PATH`: each file bundles the fixture server with `bun build --target=bun`, builds it for `linux/arm64` on `oven/bun:1.4.0-alpine` pinned by digest, and pushes it to ECR.

Before provisioning anything, every file runs the access check in `__fixtures__/access.ts`. It walks each permission the tests need to the end of the path — ending in a real `CreateAgentRuntime` against a nonexistent image, which fails on the image when IAM is right and on authorization when it is not — and fails naming exactly what is missing. It exists because on 2026-09-22 a probe checked `iam:CreateRole`, found it denied, and asked for a role, when the permission actually blocking `CreateAgentRuntime` was `iam:PassRole`.

## What each file creates, and removes

Every file provisions its own resources in `beforeAll` and deletes them in `afterAll`, all tagged `agentforge:integ=true`: an ECR repository `agentforge/integ-<purpose>-<suffix>`, a runtime `agentforge_integ_<purpose>_<suffix>`, its log groups, and — for the lease and grace-outcome tests — a DynamoDB table `agentforge-integ-lease-<purpose>-<suffix>`.

Deleting a runtime is slow: it sits in DELETING for about five minutes, and teardown waits until it and its workload identity are gone rather than returning on the call. Expect each file to take several minutes beyond its tests. A teardown that cannot delete something fails the run and names what is left. To check by tag afterwards:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=agentforge:integ,Values=true \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

## What an admin must create once

The tests run as the `agentforge` PowerUser SSO profile. `AWSPowerUserAccess` is `NotAction: ["iam:*", "organizations:*", "account:*"]`, so everything the tests do — `bedrock-agentcore*`, ECR, DynamoDB, CloudWatch Logs — is granted, **except two IAM pieces that need an admin identity**. They are prerequisites, not tests; nothing here creates or deletes them.

Run from the repository root, as an admin, in the account and region the tests use:

```bash
export AWS_REGION=us-west-2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FIXTURES=packages/agentforge/integ/agentcore/__fixtures__
render() { sed -e "s/ACCOUNT_ID/$ACCOUNT_ID/g" -e "s/REGION/$AWS_REGION/g" "$1"; }
```

**1. The execution role AgentCore assumes** — trusted by `bedrock-agentcore.amazonaws.com` for this account only; it pulls from ECR, writes the runtime's logs, and may touch DynamoDB tables and S3 buckets named `agentforge-integ-*`:

```bash
aws iam create-role --role-name agentforge-integ-agentcore-execution \
  --tags Key=agentforge:integ,Value=true \
  --assume-role-policy-document "$(render "$FIXTURES/execution-role-trust-policy.json")"

aws iam put-role-policy --role-name agentforge-integ-agentcore-execution \
  --policy-name agentforge-integ-execution \
  --policy-document "$(render "$FIXTURES/execution-role-permissions-policy.json")"
```

**2. `iam:PassRole` on that role, for the identity the tests run as**, conditioned on `iam:PassedToService: bedrock-agentcore.amazonaws.com`. Without it `CreateAgentRuntime` is refused no matter what the role allows. The `agentforge` profile is an IAM Identity Center permission set, so the grant goes on the permission set, not on the role Identity Center manages:

```bash
INSTANCE_ARN=$(aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text)
# The permission set the agentforge profile signs in with:
aws sso-admin list-permission-sets --instance-arn "$INSTANCE_ARN"
PERMISSION_SET_ARN=arn:aws:sso:::permissionSet/...   # from the list above

# Replaces the permission set's inline policy: if it already has one, merge
# this statement into it first (aws sso-admin get-inline-policy-for-permission-set).
aws sso-admin put-inline-policy-to-permission-set \
  --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PERMISSION_SET_ARN" \
  --inline-policy "$(render "$FIXTURES/agentcore-passrole-policy.json")"
aws sso-admin provision-permission-set \
  --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PERMISSION_SET_ARN" \
  --target-type AWS_ACCOUNT --target-id "$ACCOUNT_ID"
```

For a plain IAM user or role instead, attach the same rendered document with `aws iam put-user-policy` or `aws iam put-role-policy`.

### Renamed from the spikes

The spikes used `agentforge-spike-agentcore-execution` (inline policy `agentforge-spike-execution`, DynamoDB and S3 scoped to `agentforge-spike-*`), and a PassRole grant naming that role. Everything these tests create is named `agentforge-integ-*`, so the role and the grant are renamed to match; the trust policy is unchanged. Once the two steps above are done, remove the spike's role:

```bash
aws iam delete-role-policy --role-name agentforge-spike-agentcore-execution \
  --policy-name agentforge-spike-execution
aws iam delete-role --role-name agentforge-spike-agentcore-execution
```

and drop the old `PassTheSpikeExecutionRoleToAgentCoreOnly` statement from wherever the spike's PassRole grant was attached.

### Removing them

```bash
aws iam delete-role-policy --role-name agentforge-integ-agentcore-execution \
  --policy-name agentforge-integ-execution
aws iam delete-role --role-name agentforge-integ-agentcore-execution
```

and remove the PassRole statement from the permission set, then `provision-permission-set` again.
