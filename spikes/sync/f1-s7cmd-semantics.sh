#!/usr/bin/env bash
#
# §F — does s7cmd behave the way the design note assumes?
#
# The note names s7cmd as the leading implementation for working-directory sync
# and rests three design choices on it: that `LastModifiedDate` filtering is a
# usable QUIESCENCE heuristic (leave a file that is mid-write for the next
# pass), that exclusions work, and that delete propagation is an explicit
# choice rather than a default. Those are assumptions until run.
#
# Every claim below is checked against a real bucket. A claim that fails is as
# useful as one that holds — it changes what the declaration can offer.
#
# Run: bash sync/f1-s7cmd-semantics.sh
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agentforge}" AWS_REGION="${AWS_REGION:-us-west-2}"
BUCKET="${BUCKET:-agentforge-spike-sync-913756569129}"
S7="${S7:-/tmp/s7cmd}"
WORK=$(mktemp -d)
PREFIX="run-$(date +%s)"
pass=0; fail=0
ok()  { printf '  \033[32m✓\033[0m %-52s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
no()  { printf '  \033[31m✗\033[0m %-52s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
# `aws ... --output text` prints the literal "None" for an empty result, which
# a catch-all case arm will happily treat as success. It cost a false pass on
# the exclusions check on the first run of this spike; it is filtered here.
keys() { aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$1" --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | sed "s|$PREFIX/$1/||" | grep -vxF 'None' | grep -v '^$' | sort | tr '\n' ' '; }

aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 || {
  aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=agentforge:spike,Value=true}]' >/dev/null
  echo "  created bucket $BUCKET"
}

echo
echo "§F — s7cmd $($S7 --version | awk '{print $2}') against s3://$BUCKET/$PREFIX"
echo

# A working directory shaped like an agent's: source, a build tree, a git dir,
# and one file still being written.
mkdir -p "$WORK/src" "$WORK/node_modules/pkg" "$WORK/.git"
echo 'source'   > "$WORK/src/main.ts"
echo 'readme'   > "$WORK/README.md"
echo 'dep'      > "$WORK/node_modules/pkg/index.js"
echo 'gitstuff' > "$WORK/.git/HEAD"
echo 'half'     > "$WORK/src/still-being-written.ts"
# Everything is quiescent except the last file.
find "$WORK" -type f -exec touch -t 202601010000 {} \;
touch "$WORK/src/still-being-written.ts"

# ── 1. a plain upload ────────────────────────────────────────────────────────
$S7 sync "$WORK" "s3://$BUCKET/$PREFIX/plain/" >/dev/null 2>&1
got=$(keys plain)
[ -n "$got" ] && ok "local -> S3 upload" "$got" || no "local -> S3 upload" "nothing uploaded"

# ── 2. quiescence: skip anything modified in the last 30 seconds ─────────────
CUTOFF=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.UTC)-datetime.timedelta(seconds=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
$S7 sync --filter-mtime-before "$CUTOFF" "$WORK" "s3://$BUCKET/$PREFIX/quiescent/" >/dev/null 2>&1
got=$(keys quiescent)
case "$got" in
  *still-being-written*) no "quiescence: --filter-mtime-before skips a fresh file" "it uploaded: $got" ;;
  "")                    no "quiescence: --filter-mtime-before skips a fresh file" "it uploaded NOTHING — the filter is not a quiescence heuristic" ;;
  *)                     ok "quiescence: --filter-mtime-before skips a fresh file" "$got" ;;
esac

# ── 3. exclusions ────────────────────────────────────────────────────────────
$S7 sync --filter-exclude-regex '(^|/)(\.git|node_modules)/' "$WORK" "s3://$BUCKET/$PREFIX/excluded/" >/dev/null 2>&1
got=$(keys excluded)
case "$got" in
  *node_modules*|*.git/*) no "exclusions: .git and node_modules kept out" "$got" ;;
  "")                     no "exclusions: .git and node_modules kept out" "nothing uploaded" ;;
  *)                      ok "exclusions: .git and node_modules kept out" "$got" ;;
esac

# ── 4. delete propagation is OFF unless asked ────────────────────────────────
rm "$WORK/README.md"
$S7 sync "$WORK" "s3://$BUCKET/$PREFIX/plain/" >/dev/null 2>&1
got=$(keys plain)
case "$got" in
  *README.md*) ok "delete propagation is OFF by default" "README.md survived" ;;
  *)           no "delete propagation is OFF by default" "README.md was removed without being asked" ;;
esac
$S7 sync --delete "$WORK" "s3://$BUCKET/$PREFIX/plain/" >/dev/null 2>&1
got=$(keys plain)
case "$got" in
  *README.md*) no  "--delete removes what is gone locally" "README.md still there" ;;
  *)           ok  "--delete removes what is gone locally" "$got" ;;
esac

# ── 5. dry run changes nothing ───────────────────────────────────────────────
echo 'new' > "$WORK/src/added.ts"
$S7 sync --dry-run "$WORK" "s3://$BUCKET/$PREFIX/plain/" >/dev/null 2>&1
got=$(keys plain)
case "$got" in
  *added.ts*) no "--dry-run uploads nothing" "added.ts was uploaded anyway" ;;
  *)          ok "--dry-run uploads nothing" ;;
esac

# ── 6. round trip back down ──────────────────────────────────────────────────
DOWN=$(mktemp -d)
$S7 sync "s3://$BUCKET/$PREFIX/plain/" "$DOWN" >/dev/null 2>&1
[ -f "$DOWN/src/main.ts" ] && ok "S3 -> local round trip" "$(find "$DOWN" -type f | wc -l | tr -d ' ') files" || no "S3 -> local round trip" "nothing came back"

# ── 7. checksum verification is available ────────────────────────────────────
if $S7 sync --additional-checksum-algorithm SHA256 "$WORK" "s3://$BUCKET/$PREFIX/checked/" >/dev/null 2>&1; then
  ok "checksum verification (SHA256) accepted"
else
  no "checksum verification (SHA256) accepted" "flag rejected or the sync failed"
fi

aws s3 rm "s3://$BUCKET/$PREFIX" --recursive >/dev/null 2>&1
rm -rf "$WORK" "$DOWN"
echo
echo "  $pass passed, $fail failed. Test objects removed."
echo
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
