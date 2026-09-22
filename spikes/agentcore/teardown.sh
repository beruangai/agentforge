#!/usr/bin/env bash
#
# Deletes everything the AgentCore spikes created. Leaves the execution role,
# which the operator owns and this identity cannot delete anyway.
#
# Run: bash agentcore/teardown.sh
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT=913756569129
gone() { printf '  deleted  %s\n' "$1"; }
kept() { printf '  --       %s\n' "$1"; }

echo
echo "tearing down the AgentCore spike resources"
echo

for id in $(aws bedrock-agentcore-control list-agent-runtimes \
    --query 'agentRuntimes[?starts_with(agentRuntimeName, `agentforge_spike`)].agentRuntimeId' --output text 2>/dev/null); do
  aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$id" >/dev/null 2>&1 && gone "runtime $id" || kept "runtime $id (delete failed)"
done

aws ecr delete-repository --repository-name agentforge/spike-a2a --force >/dev/null 2>&1 \
  && gone "ECR repository agentforge/spike-a2a" || kept "ECR repository agentforge/spike-a2a (absent)"

aws dynamodb delete-table --table-name agentforge-spike-lease >/dev/null 2>&1 \
  && gone "DynamoDB table agentforge-spike-lease" || kept "DynamoDB table agentforge-spike-lease (absent)"

BUCKET=agentforge-spike-sync-$ACCOUNT
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 rm "s3://$BUCKET" --recursive >/dev/null 2>&1
  aws s3api delete-bucket --bucket "$BUCKET" >/dev/null 2>&1 && gone "S3 bucket $BUCKET" || kept "S3 bucket $BUCKET (delete failed)"
else
  kept "S3 bucket $BUCKET (absent)"
fi

for g in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/agentforge_spike \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
  aws logs delete-log-group --log-group-name "$g" >/dev/null 2>&1 && gone "log group $g" || kept "log group $g (delete failed)"
done

echo
kept "execution role agentforge-spike-agentcore-execution — operator-owned; run spikes/delete-execution-role.sh from an admin identity"
echo
echo "what is left tagged agentforge:spike=true:"
aws resourcegroupstaggingapi get-resources --tag-filters 'Key=agentforge:spike,Values=true' \
  --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/  /' | grep -v '^\s*$' || echo "  nothing"
echo
