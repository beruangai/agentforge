#!/usr/bin/env bash
# Removes everything setup.sh and the §D spike created. Nothing should survive.
set -uo pipefail
export DOCKER_CONFIG="${AGENTFORGE_SPIKE_DOCKER_CONFIG:-/tmp/agentforge-spike-docker}"

docker rm -f agentforge-spike-registry >/dev/null 2>&1 && echo "removed registry container"
docker buildx rm agentforge-spike >/dev/null 2>&1 && echo "removed buildx builder"
for tag in agentforge/a2a-claude:spike spike/project:spike spike/project/a:spike \
           spike/project/b:spike spike/project/c:spike d-test:one d-test:two \
           d-test2:one d-test2:two; do
  docker rmi -f "$tag" >/dev/null 2>&1 && echo "removed image $tag"
done
rm -rf "$DOCKER_CONFIG" /tmp/dockercfg
echo "teardown complete"
