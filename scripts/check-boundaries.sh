#!/usr/bin/env bash
#
# Run every production execution-boundary check with as much parallelism as is
# safe (issue #5121).
#
# The checks split into two groups:
#   * FULL-TREE scans (plutil, ffmpeg, codesign, ...) only read source files, so
#     they run concurrently.
#   * GIT-DIFF checks (`no-new-direct-*`, host-shell) compare the working tree
#     against `origin/main`, so they invoke git. Running those concurrently
#     races on `.git/shallow.lock` ("Another git process seems to be running") —
#     observed on Windows CI — so they run strictly serially, in a single
#     background sequence that overlaps the full-tree group.
#
# Every failure is reported, not just the first. This also runs the
# android-emulator and ios-ctrl-proxy-process checks that CI ran but
# `bun run lint` previously omitted, closing a local/CI parity gap.
#
# bash-3.2 safe (macOS default): arrays + a plain `wait` (no `wait -n`).
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

# Full-tree scans — safe to run all at once (no git, no shared writes).
parallel_checks=(
  "bun scripts/check-process-safety.ts"
  "bun scripts/check-no-direct-plutil.ts"
  "bun scripts/check-mcp-sdk-boundary.ts"
  "bun scripts/check-no-new-direct-git-metadata.ts"
  "bun scripts/check-utils-import-direction.ts"
  "bun scripts/check-tier-import-direction.ts"
  "bun scripts/check-no-local-shell-quote.ts"
  "bun scripts/check-app-bundle-metadata-boundary.ts"
  "bun scripts/check-ffmpeg-execution-boundary.ts"
  "bun scripts/check-child-process-import-boundary.ts"
  "bun scripts/check-simulator-tcc-sqlite-boundary.ts"
  "bun scripts/check-daemon-launcher-boundary.ts"
  "bun scripts/check-android-emulator-boundary.ts"
  "bun scripts/check-ios-ctrl-proxy-process-boundary.ts"
)

# Git-diff checks — must run serially to avoid `.git` lock contention.
serial_checks=(
  "bun scripts/check-host-shell-boundary.ts"
  "bash scripts/check-no-new-direct-simctl.sh"
  "bash scripts/check-no-new-direct-xcodebuild.sh"
  "bash scripts/check-no-new-direct-security.sh"
)

# CHECK_BOUNDARIES_CMD_OVERRIDE lets the BATS test inject a controlled check list
# (newline-separated) into the parallel group so it can exercise the aggregation
# without running the real scanners. Trusted test-only input; never wire it from
# an untrusted source.
if [[ -n "${CHECK_BOUNDARIES_CMD_OVERRIDE:-}" ]]; then
  parallel_checks=()
  serial_checks=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && parallel_checks+=("$line")
  done <<< "$CHECK_BOUNDARIES_CMD_OVERRIDE"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

run_one() {
  # $1 = tag (unique file prefix), $2 = command string (word-split intentionally)
  local out rc
  local -a command_words=()
  # Entries are whitespace-separated words, not shell programs.
  read -r -d '' -a command_words < <(printf '%s\0' "$2")
  out="$(${command_words[@]+"${command_words[@]}"} 2>&1)"
  rc=$?
  printf '%s' "$out" > "$tmp/$1.out"
  printf '%s' "$rc" > "$tmp/$1.rc"
  printf '%s' "$2" > "$tmp/$1.cmd"
}

# Launch each full-tree check concurrently.
for i in "${!parallel_checks[@]}"; do
  run_one "p$i" "${parallel_checks[$i]}" &
done

# Run the git-diff checks serially inside one background job, so the group
# overlaps the parallel group while its own members never race on git.
(
  for j in "${!serial_checks[@]}"; do
    run_one "s$j" "${serial_checks[$j]}"
  done
) &

wait

status=0
for f in "$tmp"/*.rc; do
  [[ -e "$f" ]] || continue
  rc="$(cat "$f" 2>/dev/null || echo 1)"
  [[ "$rc" == "0" ]] && continue
  status=1
  tag="$(basename "$f" .rc)"
  printf '\n--- FAIL: %s (exit %s) ---\n' "$(cat "$tmp/$tag.cmd" 2>/dev/null)" "$rc" >&2
  cat "$tmp/$tag.out" >&2
done

total=$(( ${#parallel_checks[@]} + ${#serial_checks[@]} ))
if [[ "$status" == "0" ]]; then
  echo "boundary-checks: all ${total} passed"
fi
exit "$status"
