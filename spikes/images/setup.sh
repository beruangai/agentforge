#!/usr/bin/env bash
#
# Prerequisites for the §D spike. Everything here is throwaway and removed by
# teardown.sh.
#
#   - a throwaway registry on host.docker.internal:5001, standing in for ECR
#   - a docker-container buildx builder whose buildkitd config trusts it over
#     http, because the default `docker` driver can neither export OCI nor see
#     what a container builder needs to pull
#   - a DOCKER_CONFIG without the macOS keychain credential helper, which hangs
#     without an interactive unlock and makes every pull look like a network
#     failure
#
# Run: bash images/setup.sh   (it prints the environment to export)
set -euo pipefail

BUN_TAG="oven/bun:1.4.0-alpine"
CONFIG_DIR="${AGENTFORGE_SPIKE_DOCKER_CONFIG:-/tmp/agentforge-spike-docker}"

mkdir -p "$CONFIG_DIR"
for part in cli-plugins contexts buildx; do
  [ -e "$HOME/.docker/$part" ] && cp -R "$HOME/.docker/$part" "$CONFIG_DIR/" 2>/dev/null || true
done
python3 - "$CONFIG_DIR" <<'PY'
import json, pathlib, sys
source = pathlib.Path.home() / '.docker' / 'config.json'
config = json.loads(source.read_text()) if source.exists() else {}
# The keychain helper blocks on an interactive unlock; drop it and use anonymous
# pulls, which is all a spike needs.
config.pop('credsStore', None)
config.pop('credHelpers', None)
config['auths'] = {}
(pathlib.Path(sys.argv[1]) / 'config.json').write_text(json.dumps(config, indent=2))
PY
export DOCKER_CONFIG="$CONFIG_DIR"

docker rm -f agentforge-spike-registry >/dev/null 2>&1 || true
docker run -d --name agentforge-spike-registry \
  --label agentforge:spike=true -p 5001:5000 registry:2 >/dev/null

printf '[registry."host.docker.internal:5001"]\n  http = true\n  insecure = true\n' \
  > "$CONFIG_DIR/buildkitd.toml"
docker buildx rm agentforge-spike >/dev/null 2>&1 || true
docker buildx create --name agentforge-spike --driver docker-container \
  --driver-opt network=host --config "$CONFIG_DIR/buildkitd.toml" --bootstrap >/dev/null

docker pull --platform linux/arm64 "$BUN_TAG" >/dev/null
DIGEST=$(docker image inspect "$BUN_TAG" --format '{{index .RepoDigests 0}}')

cat <<EOF

Ready. Export these, then run the spike:

  export DOCKER_CONFIG=$CONFIG_DIR
  export BUN_IMAGE=$DIGEST
  bash images/d1-deterministic-builds.sh
EOF
