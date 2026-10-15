#!/usr/bin/env bash
#
# Runs exactly the "safe" tier of *.integration.test.ts files, fully isolated,
# before a push. Complements scripts/prepush-integration.sh, which only runs the
# integration files that CHANGED: a contract change can break an integration
# test you never touched, and those only run in CI.
#
# The safe tier is test/integration-safe-tier.txt: files that use fakes over temp
# directories and never spawn or signal real processes, reach real host tooling,
# or open the default daemon socket. Every other integration file stays CI-only.
#
# Isolation: every state variable below points into one fresh mktemp directory,
# which is removed on exit. The script refuses to run if any of them (or the
# directory it would be created in) resolves under ~/.auto-mobile or
# /tmp/auto-mobile-daemon-*.
#
#   bash scripts/prepush-integration-safe.sh [safe-test-path ...]
#
# Environment:
#   AUTOMOBILE_INTEGRATION_SAFE_TIER_FILE  Override the tier list (tests).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

tier_file="${AUTOMOBILE_INTEGRATION_SAFE_TIER_FILE:-$ROOT/test/integration-safe-tier.txt}"

# shellcheck source=scripts/lib/bun-unit-test.sh disable=SC1091
source "$ROOT/scripts/lib/bun-unit-test.sh"

ISOLATION_VARS=(
  AUTOMOBILE_DATA_DIR
  AUTOMOBILE_LOG_DIR
  AUTOMOBILE_DB_DIR
  AUTOMOBILE_COORDINATION_DIR
  AUTOMOBILE_AUX_SOCKET_DIR
  AUTOMOBILE_DAEMON_SOCKET_PATH
  AUTOMOBILE_DAEMON_PID_FILE_PATH
  AUTOMOBILE_DAEMON_LOCK_FILE_PATH
)

# Prints a reason when the path lies under a shared AutoMobile location, in both
# its literal and symlink-resolved (macOS /private/tmp) form; prints nothing otherwise.
shared_location_reason() {
  local path="$1" candidate home_physical
  local -a candidates=("$path")
  if [[ -d "$path" ]]; then
    candidates+=("$(cd -P "$path" && pwd -P)")
  fi
  home_physical="$HOME"
  if [[ -d "$HOME" ]]; then
    home_physical="$(cd -P "$HOME" && pwd -P)"
  fi
  for candidate in "${candidates[@]}"; do
    while [[ "$candidate" == *//* ]]; do
      candidate="${candidate//\/\//\/}"
    done
    case "$candidate" in
      "$HOME/.auto-mobile" | "$HOME/.auto-mobile/"* | "$home_physical/.auto-mobile" | "$home_physical/.auto-mobile/"*)
        echo "under ~/.auto-mobile"
        return
        ;;
      /tmp/auto-mobile-daemon-* | /private/tmp/auto-mobile-daemon-*)
        echo "under /tmp/auto-mobile-daemon-*"
        return
        ;;
    esac
  done
}

refuse_shared_location() {
  local label="$1" path="$2" reason
  reason="$(shared_location_reason "$path")"
  if [[ -n "$reason" ]]; then
    echo "Refusing to run: ${label}=${path} resolves ${reason}." >&2
    exit 2
  fi
}

if [[ ! -f "$tier_file" ]]; then
  echo "Safe-tier list not found: ${tier_file}" >&2
  exit 2
fi

# shellcheck source=scripts/lib/integration-safe-tier.sh disable=SC1091
source "$ROOT/scripts/lib/integration-safe-tier.sh"
safe_files=()
while IFS= read -r path; do
  safe_files+=("$path")
done < <(integration_tier_paths "$tier_file" safe)

if [[ "$#" -gt 0 ]]; then
  requested_files=()
  for requested in "$@"; do
    found=0
    for safe in ${safe_files[@]+"${safe_files[@]}"}; do
      if [[ "$requested" == "$safe" ]]; then found=1; break; fi
    done
    if [[ "$found" -eq 0 ]]; then
      echo "Not in safe integration tier: $requested" >&2
      exit 2
    fi
    requested_files+=("$requested")
  done
  safe_files=("${requested_files[@]}")
fi

if [[ "${#safe_files[@]}" -eq 0 ]]; then
  echo "No safe integration files listed in ${tier_file}." >&2
  exit 2
fi

for file in "${safe_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Safe-tier file listed but missing: ${file}" >&2
    exit 2
  fi
done

tmp_base="${TMPDIR:-/tmp}"
tmp_base="${tmp_base%/}"
refuse_shared_location TMPDIR "$tmp_base"

work_dir="$(mktemp -d "${tmp_base}/am-int-safe.XXXXXX")"
# shellcheck disable=SC2317,SC2329 # invoked via the EXIT trap
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

# Variables that would override or bypass the isolation above (the DB path wins
# over DB_DIR; the AUTO_MOBILE_ aliases are read as fallbacks) or point at other
# shared state. Unset so a test falls back to the data dir under $work_dir.
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep -E '^AUTO_MOBILE_|^AUTOMOBILE_(DB_PATH|TOOL_OUTPUTS_DIR|PLAN_HEALTH_DIR|CTRL_PROXY_IOS_CACHE_DIR|DAEMON_LAUNCH_CWD|DAEMON_LAUNCH_LOG_PATH)$' || true)
# Keeps AdbClient and friends away from real adb, as scripts/prepush-node.sh does.
export AUTOMOBILE_TEST_MODE=true

export AUTOMOBILE_DATA_DIR="$work_dir/d"
export AUTOMOBILE_LOG_DIR="$work_dir/l"
export AUTOMOBILE_DB_DIR="$work_dir/db"
export AUTOMOBILE_COORDINATION_DIR="$work_dir/c"
export AUTOMOBILE_AUX_SOCKET_DIR="$work_dir/a"
export AUTOMOBILE_DAEMON_SOCKET_PATH="$work_dir/s.sock"
export AUTOMOBILE_DAEMON_PID_FILE_PATH="$work_dir/s.pid"
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH="$work_dir/s.lock"

for var in "${ISOLATION_VARS[@]}"; do
  refuse_shared_location "$var" "${!var}"
done
mkdir -p "$AUTOMOBILE_DATA_DIR" "$AUTOMOBILE_LOG_DIR" "$AUTOMOBILE_DB_DIR" \
  "$AUTOMOBILE_COORDINATION_DIR" "$AUTOMOBILE_AUX_SOCKET_DIR"

case "$(uname -s)" in
  Darwin) runner_os="macOS" ;;
  *) runner_os="Linux" ;;
esac
per_test_timeout_ms="$(bun_test_timeout_ms "${RUNNER_OS:-$runner_os}")"

log_file="$work_dir/run.log"
echo "Safe integration tier: running ${#safe_files[@]} file(s) isolated under ${work_dir}."

status=0
bun test --isolate --timeout "$per_test_timeout_ms" ${safe_files[@]+"${safe_files[@]}"} > "$log_file" 2>&1 || status=$?

if [[ "$status" -eq 0 ]]; then
  summary="$(grep -E '^ *[0-9]+ pass' "$log_file" | tail -1 | tr -d ' ' || true)"
  echo "Safe integration tier: ok (${summary:-no summary line}, ${#safe_files[@]} files)."
  exit 0
fi

echo "Safe integration tier: FAILED (exit ${status})." >&2
# Compact failure list: "<file> :: <test>" from bun's per-file headers and
# "(fail)" lines, falling back to the log tail when nothing parses.
failures="$(awk '
  /^[^ ]+\.[A-Za-z]+:$/ { current = $0; sub(/:$/, "", current); next }
  /^\(fail\)/ { line = $0; sub(/^\(fail\) /, "", line); print current " :: " line }
' "$log_file" | sort -u | head -40)"
if [[ -n "$failures" ]]; then
  printf '%s\n' "$failures" >&2
else
  tail -20 "$log_file" >&2
fi
mkdir -p scratch
cp "$log_file" scratch/prepush-integration-safe.log
echo "Full log: scratch/prepush-integration-safe.log" >&2
exit "$status"
