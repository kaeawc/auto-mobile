#!/usr/bin/env bash
#
# Run every production execution-boundary check concurrently (issue #5121).
#
# The checks are independent, side-effect-free AST/text scans, so running them
# serially in the `lint` script was pure latency (~2.8s). This runner launches
# them in parallel and reports EVERY failure, not just the first. It also
# includes the android-emulator and ios-ctrl-proxy-process checks that CI runs
# but `bun run lint` previously omitted, closing a local/CI parity gap.
#
# bash-3.2 safe (macOS default): uses arrays + a plain `wait` (no `wait -n`) and
# a temp dir to collect each check's output and exit code.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

# Each entry is invoked verbatim (word-split intentionally). These mirror the
# commands the `lint` script and the check:*-boundary npm scripts already use, so
# behavior is unchanged — only the scheduling is parallel.
checks=(
  "bun scripts/check-host-shell-boundary.ts"
  "bash scripts/check-no-new-direct-simctl.sh"
  "bun scripts/check-no-direct-plutil.ts"
  "bash scripts/check-no-new-direct-xcodebuild.sh"
  "bash scripts/check-no-new-direct-security.sh"
  "bash scripts/check-no-new-direct-git-metadata.sh"
  "bash scripts/check-no-local-shell-quote.sh"
  "bash scripts/check-app-bundle-metadata-boundary.sh"
  "bash scripts/check-ffmpeg-execution-boundary.sh"
  "bash scripts/check-simulator-tcc-sqlite-boundary.sh"
  "bash scripts/check-daemon-launcher-boundary.sh"
  "bash scripts/check-android-emulator-boundary.sh"
  "bash scripts/check-ios-ctrl-proxy-process-boundary.sh"
)

# CHECK_BOUNDARIES_CMD_OVERRIDE lets the BATS test inject a controlled check list
# (newline-separated) so it can exercise the aggregation without running the real
# scanners. Trusted test-only input; never wire it from an untrusted source.
if [[ -n "${CHECK_BOUNDARIES_CMD_OVERRIDE:-}" ]]; then
  checks=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && checks+=("$line")
  done <<< "$CHECK_BOUNDARIES_CMD_OVERRIDE"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for i in "${!checks[@]}"; do
  (
    # shellcheck disable=SC2086 # intentional word-split of "cmd arg" entries
    out="$(${checks[$i]} 2>&1)"
    rc=$?
    printf '%s' "$out" > "$tmp/$i.out"
    printf '%s' "$rc" > "$tmp/$i.rc"
  ) &
done
wait

status=0
for i in "${!checks[@]}"; do
  rc="$(cat "$tmp/$i.rc" 2>/dev/null || echo 1)"
  [[ "$rc" == "0" ]] && continue
  status=1
  printf '\n--- FAIL: %s (exit %s) ---\n' "${checks[$i]}" "$rc" >&2
  cat "$tmp/$i.out" >&2
done

if [[ "$status" == "0" ]]; then
  echo "boundary-checks: all ${#checks[@]} passed"
fi
exit "$status"
