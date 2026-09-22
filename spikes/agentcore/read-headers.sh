#!/usr/bin/env bash
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
G=$(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/agentforge_spike --query 'logGroups[0].logGroupName' --output text)
aws logs filter-log-events --log-group-name "$G" --start-time $(( ($(date +%s) - 600) * 1000 )) \
  --filter-pattern 'request' --query 'events[].message' --output text | tr '\t' '\n' | python3 -c "
import sys, json
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except: continue
    if r.get('event')!='request': continue
    names=[n for n in r['headerNames'] if not n.startswith('x-amzn-trace') and n not in ('baggage','content-length','host')]
    print(f\"  a2aVersion={str(r.get('a2aVersion')):<6} headers: {', '.join(sorted(names))}\")
"
