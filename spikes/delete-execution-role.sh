#!/usr/bin/env bash
# Tears down the role created by create-execution-role.sh. Requires IAM rights.
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-agentforge}
ROLE=agentforge-spike-agentcore-execution
aws iam delete-role-policy --role-name "$ROLE" --policy-name agentforge-spike-execution || true
aws iam delete-role --role-name "$ROLE"
echo "deleted $ROLE"
