#!/usr/bin/env bash
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
G=/aws/bedrock-agentcore/runtimes/agentforge_spike_a2a-mEyoz249T3-DEFAULT
aws logs filter-log-events --log-group-name "$G" --start-time $(( ($(date +%s) - 900) * 1000 )) \
  --filter-pattern 'lease' --query 'events[].message' --output text | tr '\t' '\n' | grep -F "${1:-}"
