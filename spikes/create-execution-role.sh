#!/usr/bin/env bash
# Creates the AgentCore execution role the AgentCore spikes need.
# Requires IAM rights: PowerUserAccess (the agentforge SSO profile) does NOT have them.
# Tear down with delete-execution-role.sh.
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-agentforge}
export AWS_REGION=${AWS_REGION:-us-west-2}
ACCOUNT=913756569129
ROLE=agentforge-spike-agentcore-execution

aws iam create-role --role-name "$ROLE" \
  --tags Key=agentforge:spike,Value=true \
  --assume-role-policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Principal\": { \"Service\": \"bedrock-agentcore.amazonaws.com\" },
      \"Action\": \"sts:AssumeRole\",
      \"Condition\": {
        \"StringEquals\": { \"aws:SourceAccount\": \"$ACCOUNT\" },
        \"ArnLike\": { \"aws:SourceArn\": \"arn:aws:bedrock-agentcore:$AWS_REGION:$ACCOUNT:*\" }
      }
    }]
  }"

aws iam put-role-policy --role-name "$ROLE" --policy-name agentforge-spike-execution \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      { \"Effect\": \"Allow\", \"Action\": [\"ecr:GetAuthorizationToken\"], \"Resource\": \"*\" },
      { \"Effect\": \"Allow\", \"Action\": [\"ecr:BatchGetImage\", \"ecr:GetDownloadUrlForLayer\", \"ecr:BatchCheckLayerAvailability\"], \"Resource\": \"arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/*\" },
      { \"Effect\": \"Allow\", \"Action\": [\"logs:CreateLogGroup\", \"logs:CreateLogStream\", \"logs:PutLogEvents\", \"logs:DescribeLogStreams\", \"logs:DescribeLogGroups\"], \"Resource\": \"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/aws/bedrock-agentcore/*\" },
      { \"Effect\": \"Allow\", \"Action\": [\"xray:PutTraceSegments\", \"xray:PutTelemetryRecords\", \"xray:GetSamplingRules\", \"xray:GetSamplingTargets\"], \"Resource\": \"*\" },
      { \"Effect\": \"Allow\", \"Action\": [\"cloudwatch:PutMetricData\"], \"Resource\": \"*\", \"Condition\": { \"StringEquals\": { \"cloudwatch:namespace\": \"bedrock-agentcore\" } } },
      { \"Effect\": \"Allow\", \"Action\": [\"bedrock-agentcore:GetWorkloadAccessToken\", \"bedrock-agentcore:GetWorkloadAccessTokenForJWT\", \"bedrock-agentcore:GetWorkloadAccessTokenForUserId\"], \"Resource\": [\"arn:aws:bedrock-agentcore:$AWS_REGION:$ACCOUNT:workload-identity-directory/default\", \"arn:aws:bedrock-agentcore:$AWS_REGION:$ACCOUNT:workload-identity-directory/default/workload-identity/*\"] },
      { \"Effect\": \"Allow\", \"Action\": [\"dynamodb:*\"], \"Resource\": \"arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/agentforge-spike-*\" },
      { \"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\", \"s3:ListBucket\"], \"Resource\": [\"arn:aws:s3:::agentforge-spike-*\", \"arn:aws:s3:::agentforge-spike-*/*\"] }
    ]
  }"

echo "arn:aws:iam::$ACCOUNT:role/$ROLE"
