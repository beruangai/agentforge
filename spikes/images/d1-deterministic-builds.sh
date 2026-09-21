#!/usr/bin/env bash
#
# DESIGN_OPTIONS §D — image determinism and deploy granularity.
#
# ADR 0008 says code ships in the image and layering is what keeps a change from
# spreading. That only holds if an UNAFFECTED agent rebuilds to a byte-identical
# image and is therefore never given a new version. This proves or disproves it:
#
#   1  build base -> agentic base -> three agents; record every manifest digest
#   2  rebuild all of it, changing nothing; every digest must be identical
#   3  change ONE agent's procedure; that agent must move, the other two must not
#   4  change the AGENTIC BASE; all three agents must move, the base must not
#   5  which reproducibility switches are load-bearing rather than cargo
#
# Digests are the MANIFEST digests a registry serves — the artifact
# `UpdateAgentRuntime` would actually receive — taken from buildx's own metadata
# after a push to a throwaway local registry. Three findings forced that setup:
# the `docker` driver cannot export OCI at all; the `docker` EXPORTER does not
# rewrite layer timestamps, so its image id moves on every build even under
# SOURCE_DATE_EPOCH; and a `docker-container` builder cannot see images in the
# daemon, so the FROM chain needs a registry. A local registry is also the
# honest model of ECR.
#
# Run: bash images/setup.sh && bash images/d1-deterministic-builds.sh
set -uo pipefail
cd "$(dirname "$0")"

# A fixed epoch removes build time from the image config. Necessary, and — as
# case 5 shows — not sufficient on its own.
export SOURCE_DATE_EPOCH=1700000000
export BUILDX_BUILDER="${BUILDX_BUILDER:-agentforge-spike}"

BUN_IMAGE="${BUN_IMAGE:?set BUN_IMAGE to a digest-pinned base}"
REGISTRY="${REGISTRY:-host.docker.internal:5001}"
OUT="../out/d1"
mkdir -p "$OUT"
: > "$OUT/log"

# Builds, pushes to the local registry, and echoes the manifest digest buildx
# itself reports. `rewrite-timestamp=true` normalises layer mtimes.
build_and_digest() {
  local name="$1" context="$2" repository="$3"; shift 3
  local metadata="$OUT/metadata-$name.json"
  docker buildx build \
    --platform linux/arm64 \
    --provenance=false \
    --output "type=registry,name=$REGISTRY/$repository:spike,rewrite-timestamp=true" \
    --metadata-file "$metadata" \
    "$@" "$context" >>"$OUT/log" 2>&1 \
    || { echo "BUILD FAILED: $name"; return 1; }
  python3 -c "import json; print(json.load(open('$metadata'))['containerimage.digest'])"
}

build_all() {
  local suffix="$1"
  BASE_DIGEST=$(build_and_digest "base$suffix" base agentforge/a2a-claude \
    --build-arg "BUN_IMAGE=$BUN_IMAGE") || return 1
  # Each stage pins its parent BY DIGEST, which is what ADR 0008 requires, and
  # what makes "the base did not move" mean "nothing above it needed to".
  AGENTIC_DIGEST=$(build_and_digest "agentic$suffix" agentic-base spike/project \
    --build-arg "BASE_IMAGE=$REGISTRY/agentforge/a2a-claude@$BASE_DIGEST") || return 1
  A_DIGEST=$(build_and_digest "agent-a$suffix" agent-a spike/project/a \
    --build-arg "AGENTIC_BASE_IMAGE=$REGISTRY/spike/project@$AGENTIC_DIGEST") || return 1
  B_DIGEST=$(build_and_digest "agent-b$suffix" agent-b spike/project/b \
    --build-arg "AGENTIC_BASE_IMAGE=$REGISTRY/spike/project@$AGENTIC_DIGEST") || return 1
  C_DIGEST=$(build_and_digest "agent-c$suffix" agent-c spike/project/c \
    --build-arg "AGENTIC_BASE_IMAGE=$REGISTRY/spike/project@$AGENTIC_DIGEST") || return 1
}

short() { echo "${1#sha256:}" | cut -c1-16; }
report() {
  printf '  %-9s %s\n' base "$(short "$BASE_DIGEST")" agentic "$(short "$AGENTIC_DIGEST")" \
    agent-a "$(short "$A_DIGEST")" agent-b "$(short "$B_DIGEST")" agent-c "$(short "$C_DIGEST")"
}
same() { [ "$1" = "$2" ] && echo IDENTICAL || echo MOVED; }

echo "=== 1. first build ==="
build_all "-1" || { echo "aborting; see $OUT/log"; exit 1; }
report
B1=$BASE_DIGEST; G1=$AGENTIC_DIGEST; A1=$A_DIGEST; BB1=$B_DIGEST; C1=$C_DIGEST

echo
echo "=== 2. rebuild with NOTHING changed ==="
build_all "-2" || exit 1
report
echo "  base    $(same "$B1" "$BASE_DIGEST")"
echo "  agentic $(same "$G1" "$AGENTIC_DIGEST")"
echo "  agent-a $(same "$A1" "$A_DIGEST")"
echo "  agent-b $(same "$BB1" "$B_DIGEST")"
echo "  agent-c $(same "$C1" "$C_DIGEST")"
REBUILD_STABLE=$([ "$A1" = "$A_DIGEST" ] && [ "$BB1" = "$B_DIGEST" ] && [ "$C1" = "$C_DIGEST" ] && [ "$B1" = "$BASE_DIGEST" ] && echo yes || echo no)

echo
echo "=== 3. change ONE agent's procedure ==="
echo "procedure for agent a, v2 — CHANGED" > agent-a/procedures/procedure.ts
build_all "-3" || exit 1
report
echo "  agentic $(same "$G1" "$AGENTIC_DIGEST")   <- must be IDENTICAL"
echo "  agent-a $(same "$A1" "$A_DIGEST")   <- must have MOVED"
echo "  agent-b $(same "$BB1" "$B_DIGEST")   <- must be IDENTICAL"
echo "  agent-c $(same "$C1" "$C_DIGEST")   <- must be IDENTICAL"
ISOLATED=$([ "$A1" != "$A_DIGEST" ] && [ "$BB1" = "$B_DIGEST" ] && [ "$C1" = "$C_DIGEST" ] && [ "$G1" = "$AGENTIC_DIGEST" ] && echo yes || echo no)
A3=$A_DIGEST

echo
echo "=== 4. change the AGENTIC BASE ==="
echo "shared capability v2 — CHANGED" > agentic-base/capabilities/shared-skill.md
build_all "-4" || exit 1
report
echo "  base    $(same "$B1" "$BASE_DIGEST")   <- must be IDENTICAL"
echo "  agentic $(same "$G1" "$AGENTIC_DIGEST")   <- must have MOVED"
echo "  agent-a $(same "$A3" "$A_DIGEST")   <- must have MOVED"
echo "  agent-b $(same "$BB1" "$B_DIGEST")   <- must have MOVED"
echo "  agent-c $(same "$C1" "$C_DIGEST")   <- must have MOVED"
SPREADS=$([ "$B1" = "$BASE_DIGEST" ] && [ "$G1" != "$AGENTIC_DIGEST" ] && [ "$A3" != "$A_DIGEST" ] && [ "$BB1" != "$B_DIGEST" ] && [ "$C1" != "$C_DIGEST" ] && echo yes || echo no)

# Restore the fixtures, so the spike is idempotent.
echo "procedure for agent a, v1" > agent-a/procedures/procedure.ts
echo "shared capability v1" > agentic-base/capabilities/shared-skill.md

echo
echo "=== 5. which switches are load-bearing ==="
probe() {
  local rewrite="$1" metadata="$OUT/probe.json"
  docker buildx build --platform linux/arm64 --provenance=false --no-cache \
    --output "type=registry,name=$REGISTRY/agentforge/probe:spike$rewrite" \
    --metadata-file "$metadata" \
    --build-arg "BUN_IMAGE=$BUN_IMAGE" base >>"$OUT/log" 2>&1 || { echo FAILED; return; }
  python3 -c "import json; print(json.load(open('$metadata'))['containerimage.digest'])"
}
WITH_1=$(probe ",rewrite-timestamp=true"); sleep 2; WITH_2=$(probe ",rewrite-timestamp=true")
echo "  SOURCE_DATE_EPOCH + rewrite-timestamp : $(same "$WITH_1" "$WITH_2")"
NOREWRITE_1=$(probe ""); sleep 2; NOREWRITE_2=$(probe "")
echo "  SOURCE_DATE_EPOCH, NO rewrite         : $(same "$NOREWRITE_1" "$NOREWRITE_2")"
unset SOURCE_DATE_EPOCH
NEITHER_1=$(probe ""); sleep 2; NEITHER_2=$(probe "")
echo "  neither                               : $(same "$NEITHER_1" "$NEITHER_2")"
export SOURCE_DATE_EPOCH=1700000000

echo
echo "========== §D VERDICT =========="
echo "  an unchanged rebuild is byte-identical        : $REBUILD_STABLE"
echo "  a change to one agent does not spread         : $ISOLATED"
echo "  a change to the agentic base moves all three  : $SPREADS"
echo "================================"

python3 - <<PY
import json, pathlib
pathlib.Path("$OUT/../d1-summary.json").write_text(json.dumps({
  "ranAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bunImage": "$BUN_IMAGE",
  "rebuildStable": "$REBUILD_STABLE",
  "changeIsolated": "$ISOLATED",
  "agenticBaseSpreads": "$SPREADS",
  "switches": {
    "epochAndRewrite": ["$WITH_1", "$WITH_2"],
    "epochOnly": ["$NOREWRITE_1", "$NOREWRITE_2"],
    "neither": ["$NEITHER_1", "$NEITHER_2"],
  },
}, indent=2))
print("summary written")
PY
