#!/usr/bin/env bash
#
# Decide whether a verified release may be promoted after main moved, and if so
# rebase it onto the new main, or recover an already-promoted release.
#
# Prepare Release builds and verifies a release commit on top of BASE (the main
# commit it started from). If main moved meanwhile, promotion is only safe when
# every new main commit touches nothing but docs/metrics/** (the daily
# release-download snapshot bot): those paths never feed a release artifact, so
# the verified artifacts still describe the rebased tree (#18175). Any other
# change refuses promotion, except the matching release commit on a retry.
#
# Usage:
#   rebase-release-past-metrics.sh check-paths
#       Read repository paths (one per line) from stdin; exit 0 when every path
#       is under docs/metrics/, else list the offenders on stderr and exit 1.
#   rebase-release-past-metrics.sh rebase <verified> <base> <main>
#       Verify BASE is an ancestor of MAIN and of VERIFIED, that BASE..MAIN only
#       touches docs/metrics/**, replay BASE..VERIFIED onto MAIN, and print the
#       rebased SHA after checking its tree differs only under docs/metrics/**.
#       On retries, reuse the oldest matching non-merge commit already on MAIN
#       whose tree differs only under docs/metrics/**. Exit 1 on any refusal.
set -euo pipefail

readonly ALLOWED_PREFIX="docs/metrics/"

die() {
  echo "$*" >&2
  exit 1
}

# awk filter printing each non-empty input path outside ALLOWED_PREFIX.
readonly OUTSIDE_PREFIX_AWK="NF && index(\$0, prefix) != 1"

# Fail with the offending paths listed when OFFENDERS (newline-separated) is
# non-empty.
require_no_offenders() {
  local offenders="$1" message="$2"
  if [[ -n "$offenders" ]]; then
    local -a paths
    mapfile -t paths <<< "$offenders"
    echo "Paths outside ${ALLOWED_PREFIX}**:" >&2
    printf '  %s\n' "${paths[@]}" >&2
    die "$message"
  fi
}

# Exit 0 when every non-empty stdin line is a path under ALLOWED_PREFIX.
check_paths() {
  local offenders
  offenders="$(awk -v prefix="$ALLOWED_PREFIX" "$OUTSIDE_PREFIX_AWK")"
  require_no_offenders "$offenders" "found paths outside ${ALLOWED_PREFIX}**"
}

worktree=""
# Drop the temporary worktree used to replay the release, on every exit path.
cleanup_worktree() {
  [[ -z "$worktree" ]] && return 0
  # Best effort: a worktree git never registered is removed by rm alone.
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"
}

rebase_release() {
  local verified base main
  verified="$(git rev-parse --verify "$1^{commit}")"
  base="$(git rev-parse --verify "$2^{commit}")"
  main="$(git rev-parse --verify "$3^{commit}")"

  git merge-base --is-ancestor "$base" "$main" \
    || die "main ($main) does not descend from the release base ($base); refusing to promote"
  git merge-base --is-ancestor "$base" "$verified" \
    || die "verified release ($verified) does not descend from its base ($base)"

  if [[ -n "$(git rev-list --merges "$base..$main")" ]]; then
    die "main gained merge commits since $base; refusing to promote"
  fi

  # Every commit must stay inside docs/metrics/**, not just the net diff: a
  # change that was later reverted still means main ran something unverified.
  local offenders
  offenders="$(git log --format= --no-renames --name-only "$base..$main" \
    | awk -v prefix="$ALLOWED_PREFIX" "$OUTSIDE_PREFIX_AWK")"
  # A previous attempt may have pushed the rebased release before tagging.
  # Its release changes appear in the history check above, so recover a tree
  # matching the verified release before refusing those changes.
  local candidate candidate_offenders
  while IFS= read -r candidate; do
    [[ -z "$(git rev-list --merges -1 "$candidate^..$candidate")" ]] || continue
    candidate_offenders="$(git diff --no-renames --name-only "$verified" "$candidate" \
      | awk -v prefix="$ALLOWED_PREFIX" "$OUTSIDE_PREFIX_AWK")"
    [[ -z "$candidate_offenders" ]] || continue
    echo "$candidate"
    return 0
  done < <(git rev-list --reverse "$base..$main")

  require_no_offenders "$offenders" \
    "main moved by more than docs/metrics/** since $base; refusing to promote a different tree"

  worktree="$(mktemp -d)"
  trap cleanup_worktree EXIT
  git worktree add --quiet --detach "$worktree" "$main" >&2
  if ! git -C "$worktree" cherry-pick "$base..$verified" >&2; then
    git -C "$worktree" cherry-pick --abort >/dev/null 2>&1 || true
    die "release commits do not replay cleanly onto main ($main); refusing to promote"
  fi
  local rebased
  rebased="$(git -C "$worktree" rev-parse HEAD)"

  offenders="$(git diff --no-renames --name-only "$verified" "$rebased" \
    | awk -v prefix="$ALLOWED_PREFIX" "$OUTSIDE_PREFIX_AWK")"
  require_no_offenders "$offenders" \
    "rebased release tree differs from the verified tree outside docs/metrics/**; refusing to promote"

  echo "$rebased"
}

case "${1:-}" in
  check-paths)
    check_paths
    ;;
  rebase)
    (($# == 4)) || die "usage: $0 rebase <verified> <base> <main>"
    rebase_release "$2" "$3" "$4"
    ;;
  *)
    die "usage: $0 check-paths | rebase <verified> <base> <main>"
    ;;
esac
