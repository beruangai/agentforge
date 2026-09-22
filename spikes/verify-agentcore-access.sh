#!/usr/bin/env bash
#
# Walks EVERY permission the AgentCore spikes need, to the end of the path, and
# reports exactly which are missing. Creates nothing durable.
#
# This exists because on 2026-09-22 the first probe checked `iam:CreateRole`,
# found it denied, and asked the operator for a role — but the permission that
# actually blocks `CreateAgentRuntime` is `iam:PassRole`, which was never
# probed. Half a fix cost the whole AgentCore half of a night. Run this BEFORE
# asking for anything, and before anyone walks away.
#
# The decisive probe is the last one: it attempts a real `CreateAgentRuntime`
# with an image URI that does not exist. If IAM is correct it fails on the
# image or on validation; if IAM is not, it fails on authorization. Either way
# nothing is created.
#
# Run: bash spikes/verify-agentcore-access.sh
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}"
export AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="${ACCOUNT:-913756569129}"
ROLE_ARN="${ROLE_ARN:-arn:aws:iam::$ACCOUNT:role/agentforge-spike-agentcore-execution}"

pass=0; fail=0
report() { # report <name> <ok|no> <detail>
  if [ "$2" = ok ]; then printf '  \033[32m✓\033[0m %-46s %s\n' "$1" "$3"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-46s %s\n' "$1" "$3"; fail=$((fail+1)); fi
}

# Runs a command; passes unless the error is an authorization failure.
probe() { # probe <name> <command...>
  local name="$1"; shift
  local output; output=$("$@" 2>&1)
  if echo "$output" | grep -qiE 'AccessDenied|not authorized|UnauthorizedOperation'; then
    report "$name" no "DENIED: $(echo "$output" | grep -oiE 'to perform: [a-zA-Z0-9:*-]+' | head -1)"
  elif echo "$output" | grep -qiE 'ExpiredToken|Token has expired|InvalidClientTokenId'; then
    report "$name" no "CREDENTIALS EXPIRED — re-authenticate and re-run"
  else
    report "$name" ok ""
  fi
}

echo
echo "identity"
IDENTITY=$(aws sts get-caller-identity --query Arn --output text 2>&1)
if echo "$IDENTITY" | grep -qiE 'expired|error'; then
  echo "  credentials are not usable: $IDENTITY"; exit 1
fi
echo "  $IDENTITY"
echo "  region $AWS_REGION, account $ACCOUNT"

echo
echo "control plane"
probe "bedrock-agentcore-control:ListAgentRuntimes" \
  aws bedrock-agentcore-control list-agent-runtimes

echo
echo "image registry (the spikes build and push an ARM64 image)"
probe "ecr:DescribeRepositories" aws ecr describe-repositories
probe "ecr:GetAuthorizationToken" aws ecr get-authorization-token

echo
echo "stores (§A's lease, and workspace sync)"
probe "dynamodb:ListTables" aws dynamodb list-tables
probe "s3:ListBuckets"      aws s3api list-buckets

echo
echo "logs (reading what the container did)"
probe "logs:DescribeLogGroups" \
  aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore

echo
echo "the execution role"
ROLE_READ=$(aws iam get-role --role-name "${ROLE_ARN##*/}" 2>&1)
if echo "$ROLE_READ" | grep -q 'NoSuchEntity'; then
  report "the role exists" no "NOT FOUND — run spikes/create-execution-role.sh from an admin identity"
elif echo "$ROLE_READ" | grep -qi 'AccessDenied'; then
  report "the role exists" ok "cannot read it (iam:GetRole denied) — harmless, PassRole is what matters"
else
  report "the role exists" ok ""
fi

echo
echo "THE DECISIVE PROBE — can this identity actually create a runtime?"
OUTPUT=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name agentforge_spike_preflight_probe \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/agentforge/does-not-exist:none\"}}" \
  --role-arn "$ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}' 2>&1)

if echo "$OUTPUT" | grep -qi 'iam:PassRole'; then
  report "CreateAgentRuntime" no "DENIED on iam:PassRole — apply spikes/agentcore-passrole-policy.json"
elif echo "$OUTPUT" | grep -qiE 'AccessDenied|not authorized'; then
  report "CreateAgentRuntime" no "DENIED: $(echo "$OUTPUT" | grep -oiE 'to perform: [a-zA-Z0-9:*-]+' | head -1)"
elif echo "$OUTPUT" | grep -qi 'agentRuntimeArn'; then
  # It should not have succeeded against a nonexistent image, but if it did,
  # do not leave it behind.
  ARN=$(echo "$OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agentRuntimeArn"])' 2>/dev/null)
  report "CreateAgentRuntime" ok "created unexpectedly; deleting $ARN"
  aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "${ARN##*/}" >/dev/null 2>&1
else
  # Failed on the image or on validation, which means authorization passed.
  report "CreateAgentRuntime" ok "IAM path is clear (failed on the dummy image, as intended)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "  $pass checks passed. The AgentCore spikes can run."
else
  echo "  $fail of $((pass+fail)) checks failed. Fix those before starting an AgentCore spike."
fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
