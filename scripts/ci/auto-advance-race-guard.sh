#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
usage() {
  cat << 'HELP'
Usage: scripts/ci/auto-advance-race-guard.sh [test-file ...]
Opt-in serial diagnostic; explicit paths replace discovery. AUTOADV_BUN selects
an alternate bun executable (default: bun). Known races can be skipped via
scripts/ci/auto-advance-race-allowlist.txt with a tracking issue comment.
Exit codes: 0 pass; 1 guard-only failures; 2 empty/invalid selection;
3 fails without guard too (takes precedence if both failure kinds occur).
HELP
}
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
  esac
done

allowlist="$ROOT/scripts/ci/auto-advance-race-allowlist.txt"
allowed=()
while IFS= read -r path; do
  [[ -n "$path" ]] && allowed+=("$path")
done < <(sed 's/#.*//;s/[[:space:]]*$//;s/^[[:space:]]*//' "$allowlist")

candidates=()
if [[ "$#" -gt 0 ]]; then
  while IFS= read -r path; do
    candidates+=("$path")
  done < <(printf '%s\n' "$@" | LC_ALL=C sort -u)
else
  while IFS= read -r path; do
    case "$path" in
      *.integration.test.ts | test/daemon/manager.test.ts) continue ;;
    esac
    candidates+=("$path")
  done < <(grep -rlE --include='*.test.ts' 'enableAutoAdvance' test | LC_ALL=C sort || true)
fi

selected=()
skipped=0
for path in ${candidates[@]+"${candidates[@]}"}; do
  skip=0
  for entry in ${allowed[@]+"${allowed[@]}"}; do
    if [[ "$path" == "$entry" ]]; then
      skip=1
      break
    fi
  done
  if [[ "$skip" -eq 1 ]]; then
    skipped=$((skipped + 1))
  elif [[ ! -f "$path" ]]; then
    echo "Missing test file: $path" >&2
    exit 2
  else
    selected+=("$path")
  fi
done
printf 'Selected %s file(s):\n' "${#selected[@]}"
for path in ${selected[@]+"${selected[@]}"}; do printf '  %s\n' "$path"; done
if [[ "${#selected[@]}" -eq 0 ]]; then
  echo "Refusing empty test selection" >&2
  printf 'Summary: selected=0 passed=0 guard-only=0 fail-both=0 skipped-by-allowlist=%s\n' "$skipped"
  exit 2
fi

# Resolve symlinks before checking the boundary; never give child tests repo TMPDIR.
temp_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
temp_parent="$(cd "$temp_parent" && pwd -P)"
case "$temp_parent/" in "$ROOT/"*) temp_parent=/tmp ;; esac
work_dir="$(mktemp -d "$temp_parent/auto-advance-race.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
export TMPDIR="$work_dir"
bun_command="${AUTOADV_BUN:-bun}"
passed=0
guard_only=()
fail_both=()
guard_logs=()
index=0
for path in "${selected[@]}"; do
  index=$((index + 1))
  log="$work_dir/$index.guard.log"
  echo "Guard: $path"
  if AUTOADV_DELAY_MS=10 "$bun_command" test --preload ./test/setup/autoAdvanceRaceGuard.ts "$path" > "$log" 2>&1; then
    passed=$((passed + 1))
  elif env -u AUTOADV_DELAY_MS "$bun_command" test "$path" > "$work_dir/$index.baseline.log" 2>&1; then
    guard_only+=("$path")
    guard_logs+=("$log")
  else
    fail_both+=("$path")
  fi
done

for index in "${!guard_only[@]}"; do
  echo "GUARD-ONLY FAILURE: ${guard_only[$index]}"
  tail -n 40 "${guard_logs[$index]}"
done
if [[ "${#guard_only[@]}" -gt 0 ]]; then
  echo "Fix the test's real-I/O dependence (inject a fake), or add it to scripts/ci/auto-advance-race-allowlist.txt with an issue reference."
fi
if [[ "${#fail_both[@]}" -gt 0 ]]; then
  echo "WARNING: fails without guard too (not guard findings):"
  for path in "${fail_both[@]}"; do printf '  %s\n' "$path"; done
fi
printf 'Summary: selected=%s passed=%s guard-only=%s fail-both=%s skipped-by-allowlist=%s\n' \
  "${#selected[@]}" "$passed" "${#guard_only[@]}" "${#fail_both[@]}" "$skipped"
if [[ "${#fail_both[@]}" -gt 0 ]]; then exit 3; fi
if [[ "${#guard_only[@]}" -gt 0 ]]; then exit 1; fi
