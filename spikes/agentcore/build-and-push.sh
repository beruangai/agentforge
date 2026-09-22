#!/usr/bin/env bash
#
# Builds the spike container for ARM64 (AgentCore Runtime takes nothing else)
# and pushes it to ECR. Prints the pushed digest.
#
# The DOCKER_CONFIG dance is not incidental: Docker Desktop on macOS stores
# registry credentials in the keychain via `credsStore: desktop`, and the
# helper hangs under a non-interactive shell ("error getting credentials —
# err: signal: terminated"). A config directory without `credsStore` fixes it,
# but must carry cli-plugins, contexts and buildx across or buildx disappears.
#
# Run: bash build-and-push.sh <tag>
set -euo pipefail
TAG="${1:?usage: build-and-push.sh <tag>}"
export AWS_PROFILE="${AWS_PROFILE:-agentforge}"
export AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="${ACCOUNT:-913756569129}"
REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
REPOSITORY="agentforge/spike-a2a"
HERE="$(cd "$(dirname "$0")" && pwd)"

export DOCKER_CONFIG=/tmp/agentforge-docker-config
mkdir -p "$DOCKER_CONFIG"
python3 - <<PY
import json, os, pathlib
source = pathlib.Path.home() / '.docker' / 'config.json'
config = json.loads(source.read_text()) if source.exists() else {}
config.pop('credsStore', None)
config.pop('credHelpers', None)
pathlib.Path(os.environ['DOCKER_CONFIG'], 'config.json').write_text(json.dumps(config))
PY
for part in cli-plugins contexts buildx; do
  [ -e "$HOME/.docker/$part" ] && [ ! -e "$DOCKER_CONFIG/$part" ] && cp -R "$HOME/.docker/$part" "$DOCKER_CONFIG/$part"
done

echo "bundling server.ts -> server.js"
(cd "$HERE/.." && bun build agentcore/server.ts --target=bun --outfile agentcore/server.js >/dev/null)

echo "logging in to $REGISTRY"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

echo "building linux/arm64 and pushing $REGISTRY/$REPOSITORY:$TAG"
docker buildx build \
  --platform linux/arm64 \
  --tag "$REGISTRY/$REPOSITORY:$TAG" \
  --metadata-file /tmp/agentcore-build-metadata.json \
  --provenance=false \
  --push \
  "$HERE"

python3 -c "import json;print('digest', json.load(open('/tmp/agentcore-build-metadata.json'))['containerimage.digest'])"
