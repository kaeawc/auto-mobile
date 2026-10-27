#!/usr/bin/env bash
# Select and run the pre-push validation lanes for changed paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Node, Android, and iOS child scripts record their own attestations. Invoke
# each selected lane once; this dispatcher must never record an attestation.
# shellcheck source=scripts/lib/vcs-diff.sh
source "${SCRIPT_DIR}/lib/vcs-diff.sh"

BASE="origin/main"
base_explicit=0
all=0
list=0
changed_mode=0
usage() {
  cat <<'EOF'
Usage: scripts/prepush.sh [--base <ref>] [--all] [--list] [--changed] [--help]

Select gates from changed paths (merge-base with origin/main plus working-tree
changes). The default base falls back to main when origin/main is unavailable;
an explicit base must resolve. --all selects every lane, --list prints the
selected names without running them, and --changed forwards to the Node lane.
PREPUSH_CHANGED_FILES_FILE may provide newline-separated paths for testing.
Lanes run serially: runtime-pins, node, shell, android, ios, integration,
integration-safe. Each platform/Node lane owns its attestation; this dispatcher
never records one.
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) [[ $# -ge 2 ]] || { echo "--base requires a ref" >&2; exit 2; }; BASE="$2"; base_explicit=1; shift 2 ;;
    --all) all=1; shift ;;
    --list) list=1; shift ;;
    --changed) changed_mode=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ -n "${PREPUSH_CHANGED_FILES_FILE:-}" ]]; then
  [[ -f "$PREPUSH_CHANGED_FILES_FILE" ]] || { echo "Changed paths file not found: $PREPUSH_CHANGED_FILES_FILE" >&2; exit 2; }
else
  # Probe in a set +e subshell so the function is not called in a condition.
  base_status="$(set +e; vcs_base_exists "$BASE" > /dev/null 2>&1; echo $?)"
  if [[ "$base_status" -ne 0 && "$base_explicit" -eq 1 ]]; then
    echo "Base ref does not resolve: $BASE" >&2
    exit 2
  fi
  if [[ "$base_status" -ne 0 ]]; then
    BASE=main
    base_status="$(set +e; vcs_base_exists "$BASE" > /dev/null 2>&1; echo $?)"
    if [[ "$base_status" -ne 0 ]]; then echo "Neither origin/main nor main resolves." >&2; exit 2; fi
  fi
fi

lane_for_path() {
  local path="$1"
  if [[ "$path" == package.json || "$path" == bun.lock ]]; then printf '%s\n' runtime-pins node integration; fi
  if [[ "$path" == src/* || ( "$path" == test/* && "$path" != test/bats/* ) || "$path" == schemas/* || "$path" == tsconfig*.json || "$path" == .oxlintrc.json || "$path" == oxlint-plugins/* || "$path" == turbo.json || "$path" == scripts/*.ts || "$path" == benchmark/agent/* ]]; then printf '%s\n' node; fi
  if [[ "$path" == scripts/*.sh || "$path" == scripts/lib/* || "$path" == test/bats/* ]]; then printf '%s\n' shell; fi
  if [[ "$path" == android/* ]]; then printf '%s\n' android; fi
  if [[ "$path" == ios/* ]]; then printf '%s\n' ios; fi
  if [[ "$path" == *.integration.test.ts || "$path" == scripts/release/pin-runtime-deps.ts || "$path" == scripts/release/runtime-graph.json || "$path" == scripts/release/lib/runtime-pins.ts || "$path" == scripts/release/lib/runtime-roots.ts || "$path" == scripts/ci/assert-installed-runtime-graph.ts || "$path" == scripts/ci/verify-pinned-runtime-graph.sh || "$path" == package.json || "$path" == bun.lock ]]; then printf '%s\n' integration; fi
  if [[ "$path" == test/fakes/* || "$path" == test/integration-safe-tier.txt || "$path" == src/models/* || "$path" == src/utils/interfaces/* ]]; then printf '%s\n' integration-safe; fi
}
lanes=(runtime-pins node shell android ios integration integration-safe)
selected=" "
mark_selected() {
  local lane="$1"
  case "$selected" in
    *" $lane "*) ;;
    *) selected+="$lane " ;;
  esac
}
if [[ "$all" -eq 1 ]]; then
  for lane in "${lanes[@]}"; do mark_selected "$lane"; done
else
  if [[ -n "${PREPUSH_CHANGED_FILES_FILE:-}" ]]; then
    paths="$(cat "$PREPUSH_CHANGED_FILES_FILE")"
  else
    path_filters=()
    paths="$( { vcs_changed_files_since_merge_base "$BASE"; vcs_touched_files ${path_filters[@]+"${path_filters[@]}"}; } | sort -u )"
  fi
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    while IFS= read -r lane; do
      if [[ -n "$lane" ]]; then mark_selected "$lane"; fi
    done < <(lane_for_path "$path")
  done <<< "$paths"
fi
selected_lanes=()
for lane in "${lanes[@]}"; do
  case "$selected" in *" $lane "*) selected_lanes+=("$lane") ;; esac
done
if [[ "$list" -eq 1 ]]; then printf '%s\n' ${selected_lanes[@]+"${selected_lanes[@]}"}; exit 0; fi
if [[ ${#selected_lanes[@]} -eq 0 ]]; then
  count=0
  if [[ -n "${paths:-}" ]]; then count="$(printf '%s\n' "$paths" | sed '/^$/d' | wc -l | tr -d ' ')"; fi
  echo "No pre-push gates selected for ${count} changed paths."
  exit 0
fi

names=(); results=(); seconds=()
run_lane() {
  local lane="$1" start status; shift
  start="$(date +%s)"; echo "==> $lane"
  lane_failed=0
  if "$@"; then status=PASS; else status=FAIL; lane_failed=1; fi
  names+=("$lane"); results+=("$status"); seconds+=("$(( $(date +%s) - start ))")
}
lane_failed=0
# Called plainly (never in a condition) so a failed lane still exits.
abort_if_failed() {
  if [[ "$lane_failed" -eq 1 ]]; then summary; exit 1; fi
}
summary() {
  echo; echo 'Pre-push dispatcher summary:'
  printf '  %-18s %-5s %s\n' LANE RESULT SECONDS
  i=0
  while [[ "$i" -lt "${#names[@]}" ]]; do
    printf '  %-18s %-5s %ss\n' "${names[$i]}" "${results[$i]}" "${seconds[$i]}"
    i=$((i + 1))
  done
}
for lane in ${selected_lanes[@]+"${selected_lanes[@]}"}; do
  case "$lane" in
    runtime-pins) run_lane "$lane" bun scripts/release/pin-runtime-deps.ts --write; abort_if_failed; echo 'Reminder: commit package.json, bun.lock, and scripts/release/runtime-graph.json if changed.' ;;
    node) args=(); if [[ "$changed_mode" -eq 1 ]]; then args+=(--changed); fi; run_lane "$lane" bash "$SCRIPT_DIR/prepush-node.sh" ${args[@]+"${args[@]}"}; abort_if_failed ;;
    shell) run_lane "$lane" bash "$SCRIPT_DIR/prepush-shell.sh" --base "$BASE"; abort_if_failed; case "$selected" in *" node "*) ;; *) run_lane 'shell format' bun run format; abort_if_failed ;; esac ;;
    android) run_lane "$lane" bash "$SCRIPT_DIR/prepush-android.sh" --base-ref "$BASE"; abort_if_failed ;;
    ios) run_lane "$lane" bash "$SCRIPT_DIR/prepush-ios.sh"; abort_if_failed ;;
    integration) AUTOMOBILE_INTEGRATION_TEST_BASE_REF="$BASE" run_lane "$lane" bash "$SCRIPT_DIR/prepush-integration.sh"; abort_if_failed ;;
    integration-safe) run_lane "$lane" bash "$SCRIPT_DIR/prepush-integration-safe.sh"; abort_if_failed ;;
  esac
done
summary
