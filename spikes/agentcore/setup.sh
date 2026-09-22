#!/usr/bin/env bash
#
# Recreates everything the AgentCore spikes need, from nothing. Roughly two
# minutes, almost all of it the image build.
#
# It does NOT create the execution role — that needs iam:CreateRole, which the
# PowerUser profile does not have. Run spikes/create-execution-role.sh from an
# admin identity once, then this.
#
# Run: bash agentcore/setup.sh [tag]
set -euo pipefail
TAG="${1:-v1}"
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT=913756569129
HERE="$(cd "$(dirname "$0")" && pwd)"
ROLE="arn:aws:iam::$ACCOUNT:role/agentforge-spike-agentcore-execution"

bash "$HERE/../verify-agentcore-access.sh" || { echo "access check failed — fix that first"; exit 1; }

aws ecr describe-repositories --repository-names agentforge/spike-a2a >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name agentforge/spike-a2a \
    --tags Key=agentforge:spike,Value=true --query 'repository.repositoryUri' --output text

aws dynamodb describe-table --table-name agentforge-spike-lease >/dev/null 2>&1 || \
  aws dynamodb create-table --table-name agentforge-spike-lease \
    --attribute-definitions AttributeName=leaseId,AttributeType=S \
    --key-schema AttributeName=leaseId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST --tags Key=agentforge:spike,Value=true \
    --query 'TableDescription.TableName' --output text

bash "$HERE/build-and-push.sh" "$TAG"

ARN=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name agentforge_spike_a2a \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/agentforge/spike-a2a:$TAG\"}}" \
  --role-arn "$ROLE" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --protocol-configuration '{"serverProtocol":"A2A"}' \
  --tags 'agentforge:spike=true' \
  --query agentRuntimeArn --output text)

echo "runtime $ARN"
until [ "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${ARN##*/}" --query status --output text)" = READY ]; do sleep 3; done
echo "READY"
echo
echo "export AGENTCORE_RUNTIME_ARN=$ARN"
