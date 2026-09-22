#!/usr/bin/env bash
#
# §D — is `bun build` byte-identical across runs?
#
# §D settled Docker-level determinism over fixtures that copy PLAIN FILES.
# Nothing was bundled, and the note names bundling as the likelier source of
# non-determinism in a real agent image: module ordering, chunk hashing and
# embedded absolute paths are all things a bundler can vary.
#
# So this bundles the real thing — the AgentCore spike server, ~1.3 MB with
# express, the A2A SDK and two AWS SDK clients — and varies, one at a time, the
# things a build pipeline actually varies:
#
#   1. the same input, same directory, twice        (is it deterministic at all?)
#   2. a DIFFERENT absolute path                    (are paths embedded?)
#   3. a different mtime on every source file       (does it read the clock?)
#   4. minified, the way a real image would ship
#
# Run: bash bundler/d2-bun-bundler-determinism.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

digest() { shasum -a 256 "$1" | cut -c1-16; }
report() { if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-44s %s\n' "$1" "$2"; else printf '  \033[31m✗\033[0m %-44s %s != %s\n' "$1" "$2" "$3"; fi; }

build() { # build <outdir> <srcdir> [extra flags...]
  local out="$1" src="$2"; shift 2
  (cd "$src" && bun build agentcore/server.ts --target=bun --outfile "$out/server.js" "$@" >/dev/null 2>&1)
  digest "$out/server.js"
}

echo
echo "§D — bun build determinism, on a real 1.3MB bundle"
echo

mkdir -p "$WORK/a" "$WORK/b"
A=$(build "$WORK/a" "$HERE")
B=$(build "$WORK/b" "$HERE")
report "same input, same path, twice" "$A" "$B"

# A copy of the tree at a different absolute path, node_modules included.
COPY="$WORK/moved-to-a-different-absolute-path"
mkdir -p "$COPY"
cp -R "$HERE/agentcore" "$HERE/node_modules" "$HERE/package.json" "$COPY/" 2>/dev/null
mkdir -p "$WORK/c"
C=$(build "$WORK/c" "$COPY")
report "same input, DIFFERENT absolute path" "$A" "$C"

# Every source file touched to a different mtime.
find "$COPY/agentcore" -name '*.ts' -exec touch -t 202001010000 {} \;
mkdir -p "$WORK/d"
D=$(build "$WORK/d" "$COPY")
report "same input, every mtime changed" "$C" "$D"

mkdir -p "$WORK/e" "$WORK/f"
E=$(build "$WORK/e" "$HERE" --minify)
F=$(build "$WORK/f" "$HERE" --minify)
report "minified, twice" "$E" "$F"

# NEGATIVE CONTROL. Four passes prove nothing unless this comparison can fail.
echo "$(printf 'console.log(%s);\n' '"a one-line change"')" >> "$COPY/agentcore/server.ts"
mkdir -p "$WORK/g"
G=$(build "$WORK/g" "$COPY")
if [ "$G" != "$C" ]; then
  printf '  \033[32m✓\033[0m %-44s %s -> %s  (the control: it CAN differ)\n' "one line added to the source" "$C" "$G"
else
  printf '  \033[31m✗\033[0m %-44s the digest did not move — this test cannot detect a change, so the passes above mean nothing\n' "one line added to the source"
fi

echo
echo "  bundle size: $(wc -c < "$WORK/a/server.js" | tr -d ' ') bytes, minified $(wc -c < "$WORK/e/server.js" | tr -d ' ') bytes"
echo "  bun $(bun --version)"
echo
if [ "$A" != "$C" ]; then
  echo "  The build path is embedded. Diff of the first difference:"
  cmp "$WORK/a/server.js" "$WORK/c/server.js" 2>&1 | head -2
  grep -c "$HERE" "$WORK/a/server.js" 2>/dev/null | sed 's/^/  occurrences of the source path in the bundle: /'
fi
echo
