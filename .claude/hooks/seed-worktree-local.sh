#!/usr/bin/env bash
# Seed a newly-created git worktree with the gitignored, machine-local files
# that local development is load-bearing on.
#
# WHY THIS EXISTS. A git worktree checks out tracked files only. Everything
# gitignored — `.env.local`, `.env.*.local`, `.claude/settings.local.json` —
# stays behind in the main checkout, so a worktree looks complete and then
# fails at runtime in ways that read like code faults. Directories are handled
# by the `worktree.symlinkDirectories` setting (node_modules, .nx, .local);
# that setting takes DIRECTORIES ONLY, which is what leaves these files to us.
#
# SYMLINK, NOT COPY. There is one set of credentials on this machine and it has
# one home. A copy drifts the moment either side is edited, and a stale copy of
# an auth file is worse than a missing one — it fails as a permissions error
# rather than as an obviously absent file.
#
# WHAT IT WILL NOT DO. It never overwrites a real file already in the worktree,
# and it only links files git actually ignores — so a tracked template like
# `.env.local.example` is left alone rather than shadowed by a symlink, which
# would show up as a spurious typechange in every diff.
#
# WHY SessionStart AND NOT WorktreeCreate. WorktreeCreate is not a
# notification that a worktree appeared — it is the thing that CREATES one,
# and configuring it replaces git worktree creation entirely (the hook is
# expected to make the worktree and print its absolute path on stdout; it
# exists so worktree isolation can work under other VCS systems). Hanging
# seeding off it would take `claude --worktree` away from git and then fail
# for want of a path. SessionStart is the first moment the new worktree is
# real, which is what seeding actually needs.
#
# Safe to run by hand against an existing worktree, and safe to run twice —
# which is what makes it fine on every session start.

set -uo pipefail

LOG="${HOME}/.claude/worktree-seed.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$LOG" 2>/dev/null; }

# --- Locate the two ends -----------------------------------------------------
#
# The hook payload's shape is not something this script depends on: it reads a
# path out of stdin if one is offered, and otherwise falls back to its own
# working directory. Either way the answer is checked against git before use, so
# a wrong guess is a no-op rather than a mess.

PAYLOAD=""
if [ ! -t 0 ]; then PAYLOAD="$(cat 2>/dev/null || true)"; fi

WT=""
if [ -n "$PAYLOAD" ] && command -v jq >/dev/null 2>&1; then
  WT="$(printf '%s' "$PAYLOAD" | jq -r '
    .worktree_path // .worktreePath // .worktree.path // .path // .cwd // empty
  ' 2>/dev/null || true)"
fi
[ -n "${1:-}" ] && WT="$1"          # explicit override, for running by hand
[ -z "$WT" ] && WT="$PWD"

# Resolve to the worktree's real root, and to the main checkout that owns it.
# `--git-common-dir` points at the ORIGINAL repository's .git from anywhere
# inside any of its worktrees, which is what makes the main checkout findable
# without knowing its path in advance.
WT_ROOT="$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$WT_ROOT" ]; then
  log "SKIP no git worktree at: $WT"
  exit 0
fi
COMMON="$(git -C "$WT_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
case "$COMMON" in
  /*) : ;;
  *) COMMON="$WT_ROOT/$COMMON" ;;
esac
MAIN_ROOT="$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd || true)"

if [ -z "$MAIN_ROOT" ] || [ "$MAIN_ROOT" = "$WT_ROOT" ]; then
  # Running in the main checkout itself. Nothing to seed, and linking a file to
  # itself is exactly the kind of damage a seeding script must never do.
  log "SKIP not a linked worktree: $WT_ROOT"
  exit 0
fi

# --- Collect the machine-local files ----------------------------------------
#
# Matched by shape (`*.local`, `*.local.*`) so a local file added later is
# picked up without editing this script. Heavy and irrelevant trees are pruned
# rather than walked — node_modules alone is 2.5 GB.

linked=0
skipped=0
while IFS= read -r src; do
  rel="${src#"$MAIN_ROOT"/}"

  # Only files git ignores. A tracked file (`.env.local.example`) is already in
  # the worktree and must not be shadowed.
  git -C "$MAIN_ROOT" check-ignore -q "$rel" 2>/dev/null || continue

  dest="$WT_ROOT/$rel"

  # Already correct — idempotent re-run.
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  # A real file here is the worktree's own. Leave it and say so.
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    log "KEEP  existing file, not replaced: $rel"
    skipped=$((skipped + 1))
    continue
  fi

  mkdir -p "$(dirname "$dest")" 2>/dev/null
  if ln -sfn "$src" "$dest" 2>/dev/null; then
    linked=$((linked + 1))
    log "LINK  $rel"
  else
    log "FAIL  could not link: $rel"
  fi
done < <(
  find "$MAIN_ROOT" \
    \( -name node_modules -o -name .git -o -name .nx -o -name dist \
       -o -name .local -o -path "$MAIN_ROOT/.claude/worktrees" \) -prune -o \
    -type f \( -name '*.local' -o -name '*.local.*' \) -print 2>/dev/null
)

log "DONE  $WT_ROOT — linked=$linked skipped=$skipped (main=$MAIN_ROOT)"

# Surfaced in the UI so a worktree that came up unseeded is visible immediately,
# rather than discovered later as a confusing runtime failure.
if [ "$linked" -gt 0 ]; then
  printf '{"systemMessage":"Worktree seeded: linked %d machine-local file(s) from the main checkout."}\n' "$linked"
fi
exit 0
