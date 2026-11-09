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
DIFF_HELPER="${RUNNER_CAPABILITY_DIFF_TS:-${SCRIPT_DIR}/runner-capability-diff.ts}"
RELEASE_GUIDE="scripts/release/check-artifact-capabilities.ts (release-candidate gate) and .github/workflows/prepare-release.yml (release and pin)"

BASE="origin/main"
base_explicit=0

usage() {
  cat <<'EOF'
Usage: scripts/release/runner-capability-note.sh [--base <ref>] [--help]

Prints a non-blocking note when the diff since the merge-base with <ref>
(default origin/main, then main), including staged, unstaged and untracked
edits, touches android/control-proxy/ or ios/control-proxy/, makes the
CtrlProxy APK or iOS runner advertise a new capability, and adds src/ code that
gates on it (scanned like the release gate). Always exits 0.
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

# Changed paths (merge-base -> working tree, untracked included) under the
# given pathspecs. Color is forced off so user config cannot alter the output.
changed_paths() {
  if vcs_uses_jj; then
    jj diff --from "$base_rev" --to @ --name-only --color=never -- "$@"
    return
  fi
  git -c color.ui=never diff --no-color --no-renames --no-ext-diff --name-only "$base_rev" -- "$@" || return 1
  git ls-files --others --exclude-standard -- "$@"
}

base_ref="$(vcs_base_ref "$BASE")"
if vcs_uses_jj; then
  vcs=jj
  base_rev="fork_point(@ | ${base_ref})"
else
  vcs=git
  if ! base_rev="$(git merge-base "$base_ref" HEAD)"; then
    note "no merge-base with '$BASE'; skipping."
    exit 0
  fi
fi

if ! runner_changes="$(changed_paths "${RUNNER_PATHS[@]}")"; then
  note "could not diff against '$BASE'; skipping."
  exit 0
fi
[[ -n "$runner_changes" ]] || exit 0

if ! host_changes="$(changed_paths "${HOST_PATHS[@]}")"; then
  note "could not diff host sources against '$BASE'; skipping."
  exit 0
fi
host_files=()
while IFS= read -r path; do
  case "$path" in *.ts | *.tsx | *.mts | *.cts) host_files+=("$path") ;; esac
done < <(printf '%s\n' "$host_changes" | sort -u)
[[ "${#host_files[@]}" -gt 0 ]] || exit 0

if ! command -v bun >/dev/null 2>&1; then
  note "bun not found; skipping."
  exit 0
fi
# The helper reuses the release gate's runner parsers and host AST scanner.
if ! used="$(bun "$DIFF_HELPER" --vcs "$vcs" --base-rev "$base_rev" "${host_files[@]}")"; then
  note "capability diff helper failed; skipping."
  exit 0
fi
[[ -n "$used" ]] || exit 0

while IFS= read -r capability; do
  message="'${capability}' is newly advertised by control-proxy sources and this change adds host code that gates on it. The daemon downloads the runner pinned in src/constants/release.ts, so the feature takes effect only after the next runner release and pin; until then the host gate fails closed. See ${RELEASE_GUIDE}."
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::notice title=Unreleased runner capability::%s\n' "$message"
  fi
  note "NOTE (non-blocking): $message"
done <<<"$used"
exit 0
