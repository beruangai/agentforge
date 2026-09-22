#!/usr/bin/env bash
# Prints, for each container id, how long it kept logging after its SIGTERM.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
G=/aws/bedrock-agentcore/runtimes/agentforge_spike_a2a-mEyoz249T3-DEFAULT
for c in "$@"; do
  aws logs filter-log-events --log-group-name "$G" --start-time $(( ($(date +%s) - 900) * 1000 )) \
    --filter-pattern "$c" --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' > "/tmp/grace-$c.txt"
  last=$(grep post-sigterm "/tmp/grace-$c.txt" | tail -1 | python3 -c 'import sys,json;l=sys.stdin.readline();print(json.loads(l)["msSinceSigterm"] if l.strip() else "none")' 2>/dev/null)
  beats=$(grep -c post-sigterm "/tmp/grace-$c.txt" 2>/dev/null || echo 0)
  live=$(grep post-sigterm "/tmp/grace-$c.txt" | tail -1 | python3 -c 'import sys,json;l=sys.stdin.readline();print(json.loads(l)["liveTasks"] if l.strip() else "-")' 2>/dev/null)
  printf '  %s  survived %8s ms after SIGTERM  (%s beats, liveTasks at the end: %s)\n' "$c" "$last" "$beats" "$live"
done
