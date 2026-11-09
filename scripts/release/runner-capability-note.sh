#!/usr/bin/env bash
# Advisory note (never a failure) for a change that adds a CtrlProxy/runner
# capability and host code that calls it in the same diff (#17618).
#
# The daemon downloads the runner pinned in src/constants/release.ts, so host
# code gated on a capability that only exists in unreleased control-proxy
# sources takes effect only after the next runner release and pin. The real
# enforcement is scripts/release/check-artifact-capabilities.ts at
# release-candidate time; this only says so earlier.
#
# The diff runs from the merge-base with --base (default origin/main, falling
# back to main) to the working tree, so committed, staged, unstaged and
# untracked edits all count. The script always exits 0.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/vcs-diff.sh
source "${SCRIPT_DIR}/../lib/vcs-diff.sh"

RUNNER_PATHS=(android/control-proxy ios/control-proxy)
HOST_PATHS=(src)
RELEASE_GUIDE="scripts/release/check-artifact-capabilities.ts (release-candidate gate) and .github/workflows/prepare-release.yml (release and pin)"

BASE="origin/main"
base_explicit=0

usage() {
  cat <<'EOF'
Usage: scripts/release/runner-capability-note.sh [--base <ref>] [--help]

Prints a non-blocking note when the diff since the merge-base with <ref>
(default origin/main, then main), including staged, unstaged and untracked
edits, adds a versioned capability under android/control-proxy/ or
ios/control-proxy/ and also adds src/ code that uses it. Always exits 0.
EOF
}

note() {
  printf 'runner-capability-note: %s\n' "$*" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 ]]; then
        note "--base requires a ref; skipping."
        exit 0
      fi
      BASE="$2"
      base_explicit=1
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      note "unknown option '$1'; skipping."
      exit 0
      ;;
  esac
done

if ! root="$(vcs_root 2>/dev/null)" || [[ -z "$root" ]]; then
  # Not a checkout (e.g. a stubbed test tree): nothing to compare.
  exit 0
fi
cd "$root" || exit 0

if ! vcs_base_exists "$BASE"; then
  if [[ "$base_explicit" -eq 0 ]] && vcs_base_exists main; then
    BASE=main
  else
    note "base ref '$BASE' does not resolve; skipping."
    exit 0
  fi
fi

# Prints a unified diff (merge-base -> working tree) for the given paths, with
# untracked files rendered as wholly added.
working_tree_diff() {
  local base_ref merge_base path
  base_ref="$(vcs_base_ref "$BASE")"
  if vcs_uses_jj; then
    jj diff --from "fork_point(@ | ${base_ref})" --to @ --git -- "$@"
    return
  fi
  merge_base="$(git merge-base "$base_ref" HEAD)" || return 1
  git diff --no-renames --no-ext-diff -U0 "$merge_base" -- "$@" || return 1
  while IFS= read -r path; do
    [[ -f "$path" ]] || continue
    printf '+++ b/%s\n' "$path"
    sed 's/^/+/' "$path"
  done < <(git ls-files --others --exclude-standard -- "$@")
}

# Versioned capability literals ("name_v1") on diff lines with the given
# sign (+ or -), excluding the +++/--- file headers.
capabilities_on() {
  local sign="$1"
  awk -v s="$sign" 'substr($0, 1, 1) == s && substr($0, 1, 4) != s s s " "' |
    grep -oE '"[a-z][a-z0-9]*(_[a-z0-9]+)*_v[0-9]+"' | tr -d '"' | sort -u
}

if ! runner_diff="$(working_tree_diff "${RUNNER_PATHS[@]}")"; then
  note "could not diff against '$BASE'; skipping."
  exit 0
fi
[[ -n "$runner_diff" ]] || exit 0

added="$(printf '%s\n' "$runner_diff" | capabilities_on +)"
removed="$(printf '%s\n' "$runner_diff" | capabilities_on -)"
# A literal both removed and re-added is a move or reformat, not a new capability.
new_capabilities="$(comm -23 <(printf '%s\n' "$added" | sed '/^$/d') <(printf '%s\n' "$removed" | sed '/^$/d'))"
[[ -n "$new_capabilities" ]] || exit 0

if ! host_diff="$(working_tree_diff "${HOST_PATHS[@]}")"; then
  note "could not diff host sources against '$BASE'; skipping."
  exit 0
fi
host_added="$(printf '%s\n' "$host_diff" | capabilities_on +)"
used="$(comm -12 <(printf '%s\n' "$new_capabilities") <(printf '%s\n' "$host_added" | sed '/^$/d'))"
[[ -n "$used" ]] || exit 0

while IFS= read -r capability; do
  message="'${capability}' is new in control-proxy sources and this change adds host code that uses it. The daemon downloads the runner pinned in src/constants/release.ts, so the feature takes effect only after the next runner release and pin; until then the host gate fails closed. See ${RELEASE_GUIDE}."
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::notice title=Unreleased runner capability::%s\n' "$message"
  fi
  note "NOTE (non-blocking): $message"
done <<<"$used"
exit 0
