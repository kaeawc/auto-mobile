#!/usr/bin/env bash
#
# Canonical Bun test-lane runner.
#
#   unit        Hermetic *.test.ts tests, excluding integration and stress.
#               Files on test/shared-process-allowlist.txt share one process
#               per shard; the rest run with --isolate, in sequential
#               processes of AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE files
#               (0 = one process) so no isolated process ages (#10583).
#               Windows: AUTOMOBILE_UNIT_TEST_WORKERS concurrent --shard
#               processes (1 keeps the single-process lane).
#   changed     Unit tests affected by worktree/ref changes (local feedback).
#   integration Real-I/O *.integration.test.ts tests.
#               Windows: AUTOMOBILE_INTEGRATION_TEST_WORKERS concurrent
#               processes (default 3; 1 keeps the single-process lane).
#   stress      Explicit test/stress/** tests.
#   coverage    Complete unit lane with LCOV coverage.
#   all         Unit, host integration, then stress.
#
# AUTOMOBILE_UNIT_RANDOM_SEED=N runs the complete unit lane in one shared
# process with randomized order (nightly advisory cross-file leak diagnostic).
#
# Device/SFU integration files remain environment-gated and are enabled by
# their dedicated package scripts and workflows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${ROOT}/scripts/lib/spotlight-exclude.sh"
cd "$ROOT"

mode="${1:-unit}"
if [[ "$#" -gt 0 ]]; then
  shift
fi

runner_os="${RUNNER_OS:-}"
if [[ -z "$runner_os" ]]; then
  case "$(uname -s 2> /dev/null || true)" in
    Darwin) runner_os="macOS" ;;
    MINGW* | MSYS* | CYGWIN*) runner_os="Windows" ;;
  esac
fi

cores="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
if ! [[ "$cores" =~ ^[0-9]+$ ]] || [[ "$cores" -lt 1 ]]; then
  cores=4
fi

if [[ "$cores" -le 4 ]]; then
  default_workers=$((cores - 1))
else
  default_workers=$((cores - 2))
fi
if [[ "$default_workers" -lt 2 ]]; then
  default_workers=2
fi

# Owner decision on #8381: GitHub-hosted macOS unit lanes run 3 workers. Keyed on the
# runner-provided RUNNER_OS (not uname) so local macOS development keeps the core-based default.
# Runners with fewer than 3 cores keep the 2-worker minimum rather than oversubscribing.
if [[ "${RUNNER_OS:-}" == "macOS" && "$cores" -ge 3 ]]; then
  default_workers=3
fi

unit_workers="${AUTOMOBILE_UNIT_TEST_WORKERS:-$default_workers}"
# shellcheck source=scripts/lib/bun-unit-test.sh
source "$ROOT/scripts/lib/bun-unit-test.sh"
per_test_timeout_ms="$(bun_test_timeout_ms "$runner_os")"
case "$mode" in
  unit | changed) configure_bun_unit_test "$ROOT" "$runner_os" ;;
esac
if [[ -z "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" && "$runner_os" != "Windows" ]]; then
  case "$mode" in
    unit | changed) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=180 ;;
    integration) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=900 ;;
    stress) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=300 ;;
    coverage) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 ;;
  esac
fi

validate_positive_integer() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "${label} must be a positive integer, got: ${value}" >&2
    exit 2
  fi
}

# macOS-only (iOS) tests (owner rule 2026-10-23: iOS tests never run on Linux or
# Windows). test/macos-only-tests.txt classifies them; scripts/lib/macOsOnlyTests.ts
# applies it. AUTOMOBILE_MACOS_ONLY_TESTS=auto (default) skips them on any host
# that is not macOS, "include" runs them anywhere, "skip" drops them even on macOS.
# Design: docs/design-docs/ci/macos-only-tests.md.
macos_only_tool="$ROOT/scripts/lib/macOsOnlyTests.ts"
case "${AUTOMOBILE_MACOS_ONLY_TESTS:-auto}" in
  include) skip_macos_only=0 ;;
  skip) skip_macos_only=1 ;;
  auto)
    if [[ "$runner_os" == macOS ]]; then skip_macos_only=0; else skip_macos_only=1; fi
    ;;
  *)
    echo "AUTOMOBILE_MACOS_ONLY_TESTS must be auto, include or skip, got: ${AUTOMOBILE_MACOS_ONLY_TESTS}" >&2
    exit 2
    ;;
esac

# The skip list is read once, up front: a classification that cannot be read must
# fail the lane, not quietly leave every file in or out.
macos_only_skip_file=""
case "$mode" in
  unit | changed | integration | coverage)
    if [[ "$skip_macos_only" -eq 1 ]]; then
      macos_only_skip_file="${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}/macos-only-tests.list"
      mkdir -p "$(dirname "$macos_only_skip_file")"
      if ! bun "$macos_only_tool" list > "$macos_only_skip_file"; then
        echo "test-ts: cannot read the macOS-only test classification (test/macos-only-tests.txt)" >&2
        exit 2
      fi
    fi
    ;;
  *) skip_macos_only=0 ;;
esac

# Drops macOS-only paths from a newline-delimited list on stdin when this host skips them.
macos_only_filter() {
  if [[ "$skip_macos_only" -eq 1 ]]; then
    # grep -v exits 1 when every line is dropped; an empty list is a valid result.
    grep -v -x -F -f "$macos_only_skip_file" || true
  else
    cat
  fi
}

# Bun finds files itself on some paths (Windows shards, --changed, the integration
# filter), so hand it a bunfig copy that ignores the macOS-only files. An ignore
# pattern beats an explicit file argument, and a config file has no argv length cap.
# The path is relative to the repo root (the lane's cwd) unless the scratch dir is
# overridden, so Git Bash never rewrites it. $1 is the argument array to extend.
add_macos_only_bun_config() {
  [[ "$skip_macos_only" -eq 1 ]] || return 0
  local config="scratch/bunfig.macos-only.toml"
  if [[ -n "${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-}" ]]; then
    config="$AUTOMOBILE_TEST_TS_SCRATCH_DIR/bunfig.macos-only.toml"
  fi
  mkdir -p "$(dirname "$config")"
  bun "$macos_only_tool" write-bunfig "$config"
  case "$1" in
    unit) unit_args+=("--config=$config") ;;
    integration) integration_args+=("--config=$config") ;;
  esac
}

# shellcheck source=scripts/lib/host-slots.sh
source "$ROOT/scripts/lib/host-slots.sh"
export AUTOMOBILE_TEST_TS_PARENT_PID="$$"
cleanup_pids=()
cleanup_command_groups=()
cleanup_pgid_prefixes=()
exit_report_dir=""
randomized_summary=0

cleanup_test_processes() {
  local prefix record cmd watcher _ pid signal group managed active=0
  local groups=(${cleanup_command_groups[@]+"${cleanup_command_groups[@]}"})
  # Stop shard launchers first so no new command can escape the recorded set.
  for pid in ${cleanup_pids[@]+"${cleanup_pids[@]}"}; do
    managed=0
    for group in ${cleanup_command_groups[@]+"${cleanup_command_groups[@]}"}; do
      if [[ "$pid" == "$group" ]]; then managed=1; break; fi
    done
    # Group-managed shells receive TERM once, below. A second TERM during
    # entry to their EXIT trap can interrupt cleanup before traps are ignored.
    if [[ "$managed" -eq 1 ]]; then continue; fi
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      active=1
    fi
  done
  for prefix in ${cleanup_pgid_prefixes[@]+"${cleanup_pgid_prefixes[@]}"}; do
    for record in "$prefix".*; do
      [[ -f "$record" ]] || continue
      read -r cmd watcher _ < "$record" || continue
      for pid in "$cmd" "$watcher"; do
        if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then groups+=("$pid"); fi
      done
    done
  done
  for signal in TERM KILL; do
    for pid in ${groups[@]+"${groups[@]}"}; do
      if kill -0 -- "-$pid" 2>/dev/null; then
        kill -"$signal" -- "-$pid" 2>/dev/null || true
        active=1
      fi
    done
    if [[ "$signal" == TERM && "$active" -eq 1 ]]; then
      sleep "${AUTOMOBILE_WATCHDOG_KILL_GRACE_SECONDS:-2}"
      # Nested lanes need their own grace interval before releasing host slots.
      # Give their EXIT traps time to finish before escalating the outer group.
      if [[ "$mode" == all ]]; then sleep 1; fi
    fi
  done
  for pid in ${cleanup_pids[@]+"${cleanup_pids[@]}"}; do
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  cleanup_pids=()
  cleanup_command_groups=()
}

forget_cleanup_pid() {
  local reaped="$1" pid remaining=()
  for pid in ${cleanup_pids[@]+"${cleanup_pids[@]}"}; do
    if [[ "$pid" != "$reaped" ]]; then remaining+=("$pid"); fi
  done
  cleanup_pids=(${remaining[@]+"${remaining[@]}"})
  remaining=()
  for pid in ${cleanup_command_groups[@]+"${cleanup_command_groups[@]}"}; do
    if [[ "$pid" != "$reaped" ]]; then remaining+=("$pid"); fi
  done
  cleanup_command_groups=(${remaining[@]+"${remaining[@]}"})
}

# A shell waiting on a foreground executable defers traps. Background jobs plus
# wait are interruptible; monitor mode gives cleanup a group for descendants.
run_managed_command() {
  local pid status=0 had_monitor=0
  case "$-" in *m*) had_monitor=1 ;; esac
  set -m
  "$@" 3>&- &
  pid=$!
  cleanup_pids+=("$pid")
  cleanup_command_groups+=("$pid")
  if [[ "$had_monitor" -eq 0 ]]; then set +m; fi
  wait "$pid" || status=$?
  forget_cleanup_pid "$pid"
  return "$status"
}

test_ts_exit() {
  local status="$?"
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  cleanup_test_processes
  host_slots_release
  if [[ "$randomized_summary" -eq 1 ]]; then randomized_failure_summary "$status"; fi
  if [[ -n "$exit_report_dir" ]]; then rm -rf "$exit_report_dir"; fi
  exit "$status"
}
trap test_ts_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cap_unit_workers() {
  local demand="$1"
  run_capture_status host_slots_acquire "$demand" "$cores"
  if [[ "$RUN_STATUS" -ne 0 ]]; then return "$RUN_STATUS"; fi
  capped_workers="$host_slots_acquired"
  if [[ "$capped_workers" -lt 1 ]]; then capped_workers=1; fi
  if [[ "$capped_workers" -gt "$demand" ]]; then capped_workers="$demand"; fi
  printf 'test-ts: host slots demand=%s acquired=%s workers=%s\n' \
    "$demand" "$host_slots_acquired" "$capped_workers" >&2
}

host_load_exceeds_cores() {
  local load=""
  if [[ -n "${AUTOMOBILE_TEST_LOADAVG_FILE:-}" ]]; then
    read -r load _ < "$AUTOMOBILE_TEST_LOADAVG_FILE" || true
  elif [[ -r /proc/loadavg ]]; then
    read -r load _ < /proc/loadavg || true
  else
    load="$(sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/, ""); print $1}')"
  fi
  if [[ "$load" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v host_load="$load" -v core_count="$cores" 'BEGIN {exit !(host_load > core_count)}'; then
    printf 'test-ts: not retrying unit shard %d: host load %s > cores %s\n' "$1" "$load" "$cores" >&2
    return 0
  fi
  return 1
}

validate_positive_integer "AUTOMOBILE_UNIT_TEST_WORKERS" "$unit_workers"
if [[ "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES+x}" == x ]]; then
  validate_positive_integer "AUTOMOBILE_UNIT_TEST_CHUNK_FILES" "$AUTOMOBILE_UNIT_TEST_CHUNK_FILES"
fi
# 0 keeps one isolated process per shard; see scripts/lib/bun-unit-groups.sh.
isolated_chunk_size="$(unit_isolated_chunk_size)"
if ! [[ "$isolated_chunk_size" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
  echo "AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE must be a non-negative integer below 1000000000, got: ${isolated_chunk_size}" >&2
  exit 2
fi
validate_positive_integer "AUTOMOBILE_TEST_TIMEOUT_MS" "$per_test_timeout_ms"

# Capture an expected failure explicitly, preserving the caller's errexit option.
# The command runs in this shell so its result variables remain available.
run_capture_status() {
  local caller_options="$-" captured_status
  set +e
  "$@"
  captured_status=$?
  if [[ "$caller_options" == *e* ]]; then set -e; fi
  RUN_STATUS=$captured_status
}

run_test_command() {
  local caller_options="$-"
  if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    validate_positive_integer \
      "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
      "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
  fi

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi

  if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    # shellcheck source=scripts/ios/run_with_timeout.sh
    source "$ROOT/scripts/ios/run_with_timeout.sh"
    local start_seconds
    local elapsed_seconds
    local status
    start_seconds="$(date +%s)"
    # run_with_timeout's 124 status is expected here when the deadline fires.
    set +e
    local native_timeout=1
    if [[ ( "$mode" == unit || "$mode" == changed ) && "$runner_os" != Windows ]] ||
      [[ -n "${AUTOMOBILE_FORCE_PORTABLE_TIMEOUT:-}${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE:-}" || -r "${AUTOMOBILE_WATCHDOG_TIMING_LOG:-}" ]]; then
      native_timeout=0
    fi
    if [[ "$native_timeout" -eq 1 ]] && command -v timeout >/dev/null 2>&1; then
      run_managed_command timeout -k 2 "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$@"
    elif [[ "$native_timeout" -eq 1 ]] && command -v gtimeout >/dev/null 2>&1; then
      run_managed_command gtimeout -k 2 "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$@"
    else
      local pgid_prefix
      mkdir_spotlight_excluded_within "$ROOT" "${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}"
      pgid_prefix="$(mktemp "${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}/test-ts-pgid.XXXXXX")"
      rm -f "$pgid_prefix"
      cleanup_pgid_prefixes+=("$pgid_prefix")
      AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$pgid_prefix" \
        run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$@"
    fi
    status=$?
    if [[ "$caller_options" == *e* ]]; then set -e; fi
    elapsed_seconds=$(($(date +%s) - start_seconds))
    if [[ "$status" -eq 124 && ( "$mode" == "stress" || "$mode" == "coverage" ) ]]; then
      local mode_label
      case "$mode" in
        coverage) mode_label="Coverage" ;;
        stress) mode_label="Stress" ;;
      esac
      printf '%s test run exceeded its %ss wall-clock budget (ran ~%ss); see #6969 for the ongoing margin investigation.\n' \
        "$mode_label" "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$elapsed_seconds" >&2
    fi
    return "$status"
  fi

  run_managed_command "$@"
}

lane_for_test_path() {
  local path="$1"
  case "$path" in
    test/stress/*) printf '%s\n' "stress" ;;
    *.integration.test.ts) printf '%s\n' "integration" ;;
    *) printf '%s\n' "unit" ;;
  esac
}

add_test_path_to_lane() {
  local path="$1"
  case "$(lane_for_test_path "$path")" in
    unit) unit_test_paths+=("$path") ;;
    integration) integration_test_paths+=("$path") ;;
    stress) stress_test_paths+=("$path") ;;
  esac
}

canonical_file_target() {
  local target="$1"
  local target_directory
  local link_target

  target="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
  while [[ -L "$target" ]]; do
    target_directory="$(cd "$(dirname "$target")" && pwd -P)"
    link_target="$(readlink "$target")"
    if [[ "$link_target" == /* ]]; then
      target="$link_target"
    else
      target="$target_directory/$link_target"
    fi
    target="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
  done
  printf '%s\n' "$target"
}

canonical_test_target() {
  local requested_target="$1"
  local absolute_target

  if [[ -f "$requested_target" ]]; then
    absolute_target="$(canonical_file_target "$requested_target")"
  elif [[ -d "$requested_target" ]]; then
    absolute_target="$(cd "$requested_target" && pwd -P)"
  else
    printf '%s\n' "__missing__"
    return
  fi

  if [[ "$absolute_target" == "$ROOT/test" ]]; then
    printf '%s\n' "test"
  elif [[ "$absolute_target" == "$ROOT/test/"* ]]; then
    printf '%s\n' "${absolute_target#"$ROOT"/}"
  else
    printf '%s\n' "__outside_test__"
  fi
}

add_test_target() {
  local requested_target="$1"
  local target
  local test_path
  local found=0
  local is_file_target=0

  if [[ -f "$requested_target" ]]; then
    is_file_target=1
  fi

  target="$(canonical_test_target "$requested_target")"
  case "$target" in
    __missing__)
      echo "No test files found for target: $requested_target" >&2
      exit 2
      ;;
    __outside_test__)
      echo "Test target must be inside test/: $requested_target" >&2
      exit 2
      ;;
  esac

  if [[ "$is_file_target" -eq 1 ]]; then
    if [[ "$target" != *.test.ts ]]; then
      echo "Test target is not a Bun test file: $requested_target" >&2
      exit 2
    fi
    add_test_path_to_lane "$target"
    return
  fi

  while IFS= read -r test_path; do
    found=1
    add_test_path_to_lane "$test_path"
  done < <(find "$target" -type f -name '*.test.ts' -print | sort)
  if [[ "$found" -eq 1 ]]; then
    return
  fi

  echo "No test files found for target: $requested_target" >&2
  exit 2
}

unit_test_paths=()
integration_test_paths=()
stress_test_paths=()
passthrough_args=()
has_test_targets=0
args=("$@")
for ((arg_index = 0; arg_index < ${#args[@]}; arg_index += 1)); do
  arg="${args[$arg_index]}"
  if [[ "$arg" == --cwd || "$arg" == --cwd=* ]]; then
    echo "--cwd is not supported because test lanes are resolved from the repository root." >&2
    exit 2
  elif [[ "$arg" == --bail || "$arg" == --parallel ]]; then
    passthrough_args+=("$arg")
    next_arg="${args[$((arg_index + 1))]:-}"
    if [[ "$next_arg" =~ ^[0-9]+$ ]]; then
      passthrough_args+=("$next_arg")
      arg_index=$((arg_index + 1))
    fi
  elif [[ "$arg" == --changed || "$arg" == --inspect || "$arg" == --inspect-wait || "$arg" == --inspect-brk ]]; then
    passthrough_args+=("$arg")
    next_arg="${args[$((arg_index + 1))]:-}"
    next_target="$(canonical_test_target "$next_arg")"
    if [[ "$next_target" == "test" || "$next_target" == test/* || ( "$next_target" == "__missing__" && ( "$next_arg" == test || "$next_arg" == test/* || "$next_arg" == ./test || "$next_arg" == ./test/* || "$next_arg" == "$ROOT"/test || "$next_arg" == "$ROOT"/test/* ) ) ]]; then
      :
    elif [[ -n "$next_arg" && "$next_arg" != -* ]]; then
      passthrough_args+=("$next_arg")
      arg_index=$((arg_index + 1))
    fi
  elif [[ "$arg" == --timeout || "$arg" == --rerun-each || "$arg" == --retry || "$arg" == --seed || "$arg" == --coverage-reporter || "$arg" == --coverage-dir || "$arg" == --test-name-pattern || "$arg" == "-t" || "$arg" == --reporter || "$arg" == --reporter-outfile || "$arg" == --max-concurrency || "$arg" == --path-ignore-patterns || "$arg" == --parallel-delay || "$arg" == --shard || "$arg" == --preload || "$arg" == --require || "$arg" == "-r" || "$arg" == --import || "$arg" == --cpu-prof-name || "$arg" == --cpu-prof-dir || "$arg" == --cpu-prof-interval || "$arg" == --heap-prof-name || "$arg" == --heap-prof-dir || "$arg" == --install || "$arg" == "--eval" || "$arg" == "-e" || "$arg" == --print || "$arg" == "-p" || "$arg" == --port || "$arg" == --conditions || "$arg" == --fetch-preconnect || "$arg" == --max-http-header-size || "$arg" == --dns-result-order || "$arg" == --unhandled-rejections || "$arg" == --console-depth || "$arg" == --user-agent || "$arg" == --cron-title || "$arg" == --cron-period || "$arg" == --elide-lines || "$arg" == "--filter" || "$arg" == "-F" || "$arg" == --shell || "$arg" == --env-file || "$arg" == --config || "$arg" == "-c" ]]; then
    passthrough_args+=("$arg")
    if [[ "$arg_index" -lt $((${#args[@]} - 1)) ]]; then
      arg_index=$((arg_index + 1))
      passthrough_args+=("${args[$arg_index]}")
    fi
  elif [[ "$arg" == -* ]]; then
    passthrough_args+=("$arg")
  else
    has_test_targets=1
    add_test_target "$arg"
  fi
done

# Explicit file or directory targets: drop macOS-only files this host skips, and
# stop cleanly when that leaves nothing, so `test-ts.sh unit test/utils` on Linux
# still works.
macos_only_skipped_targets=0
if [[ "$skip_macos_only" -eq 1 ]]; then
  macos_only_kept=()
  if [[ "${#unit_test_paths[@]}" -gt 0 ]]; then
    macos_only_kept=()
    while IFS= read -r file; do
      macos_only_kept+=("$file")
    done < <(printf '%s\n' "${unit_test_paths[@]}" | macos_only_filter)
    macos_only_skipped_targets=$((macos_only_skipped_targets + ${#unit_test_paths[@]} - ${#macos_only_kept[@]}))
    unit_test_paths=(${macos_only_kept[@]+"${macos_only_kept[@]}"})
  fi
  if [[ "${#integration_test_paths[@]}" -gt 0 ]]; then
    macos_only_kept=()
    while IFS= read -r file; do
      macos_only_kept+=("$file")
    done < <(printf '%s\n' "${integration_test_paths[@]}" | macos_only_filter)
    macos_only_skipped_targets=$((macos_only_skipped_targets + ${#integration_test_paths[@]} - ${#macos_only_kept[@]}))
    integration_test_paths=(${macos_only_kept[@]+"${macos_only_kept[@]}"})
  fi
  if [[ "$macos_only_skipped_targets" -gt 0 &&
    "${#unit_test_paths[@]}" -eq 0 && "${#integration_test_paths[@]}" -eq 0 && "${#stress_test_paths[@]}" -eq 0 ]]; then
    printf 'test-ts: all %s requested test file(s) are macOS-only (iOS); skipped on this host (AUTOMOBILE_MACOS_ONLY_TESTS=include runs them)\n' \
      "$macos_only_skipped_targets" >&2
    exit 0
  fi
fi

# Count line on stderr, plus a step-summary section in CI, so skipped iOS files stay visible.
if [[ "$skip_macos_only" -eq 1 && "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
  case "$mode" in
    unit | changed | integration | coverage)
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        bun "$macos_only_tool" report --markdown >> "$GITHUB_STEP_SUMMARY" || true
      else
        bun "$macos_only_tool" report || true
      fi
      ;;
  esac
fi

# Both the ordinary shards and the randomized diagnostic consume this list.
discover_unit_test_files() {
  local file
  if [[ -n "${unit_selection_file:-}" ]]; then
    macos_only_filter < "$unit_selection_file"
    return
  fi
  while IFS= read -r file; do
    case "$file" in
      *.integration.test.ts | test/stress/*) ;;
      *) printf '%s\n' "$file" ;;
    esac
  done < <(find test -type f -name '*.test.ts' -print | sort | macos_only_filter)
}

# Markdown backticks are literal formatting, not shell substitutions.
randomized_failure_summary() {
  local status="$1"
  if [[ "$status" -ne 0 && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### Randomized unit lane failed (exit %s)\n\n' "$status"
      printf "Seed: \`%s\`\n\n" "$AUTOMOBILE_UNIT_RANDOM_SEED"
      printf "Reproduce the same unit file list:\n\`\`\`bash\n"
      printf 'AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_RANDOM_SEED=%s bash scripts/test-ts.sh unit\n' "$AUTOMOBILE_UNIT_RANDOM_SEED"
      printf "\`\`\`\nEquivalent Bun invocation (explicit unit files):\n\`\`\`bash\n"
      printf "bun test --randomize --seed=%s <files>\n\`\`\`\n" "$AUTOMOBILE_UNIT_RANDOM_SEED"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

run_randomized_unit() {
  local seed="$AUTOMOBILE_UNIT_RANDOM_SEED"
  local file
  local test_files=()
  validate_positive_integer "AUTOMOBILE_UNIT_RANDOM_SEED" "$seed"
  if [[ "${#seed}" -gt 10 ]] || ((10#$seed > 4294967295)); then
    echo "AUTOMOBILE_UNIT_RANDOM_SEED must fit Bun's unsigned 32-bit seed." >&2
    exit 2
  fi
  printf 'test-ts: randomized unit lane seed=%s\n' "$seed"
  randomized_summary=1
  if [[ "$has_test_targets" -ne 0 || "${#passthrough_args[@]}" -ne 0 ]]; then
    echo "Randomized unit lane requires the complete unit file list and no extra arguments." >&2
    exit 2
  fi
  while IFS= read -r file; do
    test_files+=("$file")
  done < <(discover_unit_test_files)
  if [[ "${#test_files[@]}" -eq 0 ]]; then
    echo "No unit test files discovered" >&2
    exit 1
  fi
  # Intentionally omit --isolate, --parallel and sharding: sibling files must
  # share module/global state for this diagnostic to expose cross-file leaks.
  run_test_command bun test --timeout "$per_test_timeout_ms" \
    --randomize "--seed=$seed" "${test_files[@]}"
}

# Shared-process split (#10583). Files on the allow-list (tier C: no static
# shared-state signal, see scripts/test/classify-shared-safe.ts) run together
# in one non-isolated `bun test` process per shard; every other file keeps
# --isolate. New files run isolated until the list is regenerated.
# AUTOMOBILE_UNIT_SHARED_PROCESS=0 runs every file isolated, as before.
# Prints the allow-listed members of the discovered unit files, in order.
shared_process_unit_files() {
  local allowlist="${AUTOMOBILE_UNIT_SHARED_ALLOWLIST:-$ROOT/test/shared-process-allowlist.txt}"
  if [[ "${AUTOMOBILE_UNIT_SHARED_PROCESS:-1}" == 0 || ! -f "$allowlist" ]]; then
    return 0
  fi
  local discovered
  discovered="$(discover_unit_test_files)"
  # grep exits 1 when nothing matches; an empty group is a valid result.
  grep -Fx -f <(tr -d '\r' < "$allowlist" | grep -v -e '^#' -e '^$') <<< "$discovered" || true
}

# Called in a unit shard's subshell. Allow-listed files lead the shard's list
# (run_unit_shards orders them first and assigns round-robin), so the shard's
# shared count follows from shared_total. Reads and sets run_unit_shards'
# locals through Bash's dynamic scoping.
configure_unit_shard_groups() {
  local shard="$1"
  export AUTOMOBILE_UNIT_SHARED_FILE_COUNT=0
  if [[ "$shared_total" -gt "$shard" ]]; then
    AUTOMOBILE_UNIT_SHARED_FILE_COUNT=$(((shared_total - shard + worker_count - 1) / worker_count))
  fi
  if [[ "$shard_mode" == changed ]]; then
    if [[ "$isolated_chunk_size" -eq 0 ]]; then
      isolated_chunk_size="$UNIT_ISOLATED_CHUNK_DEFAULT"
    fi
    export AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE="$isolated_chunk_size"
    export AUTOMOBILE_UNIT_SHARED_CHUNK_SIZE="$isolated_chunk_size"
  fi
  # Nightly-chunked shards split inside bun-unit-chunks.sh. Other shards run
  # their groups (shared process, then fixed-size isolated chunks) through
  # bun-unit-groups.sh under the same watchdog; with no shared files and an
  # isolated chunk size of 0 the direct single invocation is kept.
  if [[ ( "$shard_mode" == changed || -z "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ) &&
    ("$AUTOMOBILE_UNIT_SHARED_FILE_COUNT" -gt 0 || "$isolated_chunk_size" -gt 0) ]]; then
    shard_args=(bash "$ROOT/scripts/lib/bun-unit-groups.sh" "$ROOT" "$runner_os"
      "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" "$shard")
  fi
}

# Infra-exit retry for unit shards (#10583). A unit shard that hits its
# wall-clock budget (status 124) or is killed by a signal (status 129-192, for
# example 137 from the OOM killer or the watchdog's KILL escalation) is re-run
# ONCE with the same budget before the lane fails. An ordinary failure (exit 1
# with failing tests) is never retried. A hosted-runner shutdown (exit 143 on
# the whole job) signals this script as well, so it cannot be retried here;
# that job must be re-run (see scripts/ci/known-flakes.txt).
#
# Wall-time arithmetic (CI sets AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720):
#   one attempt <= budget + UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS (60s covers the
#                  watchdog's 2s TERM->KILL grace, two calibration probes capped
#                  at UNIT_CALIBRATION_TIMEOUT_SECONDS each, one bounded
#                  calibration lookup, and the timing summary)
#   lane cap    =  AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS, by default
#                  2 * (budget + overhead) = 2 * (720 + 60) = 1560s (26 min)
#   A calibrated timeout at >= AUTOMOBILE_UNIT_CONTENDED_SLOWDOWN (default 2.5x)
#   skips the same-runner retry: one attempt <= 720 + 60 = 780s (13 min).
#   All shards timing out after two attempts emits RUNNER-STARVED-SUSPECTED,
#   even below the calibrated contention threshold; exit/retry policy is unchanged.
#   A retry starts only while elapsed + budget + overhead <= lane cap, so the
#   lane ends within its cap however many shards retry: retries run in
#   parallel, each launched as soon as its first attempt is reaped. Attempts
#   are reaped in completion order (#10644), so `elapsed` is the lane time at
#   which that first attempt actually ended, not when a slower lower-index
#   shard did; every attempt still ends by its start + budget + overhead. Job
#   timeouts in pull_request.yml and merge.yml are sized against this cap.
# Chunked shards (AUTOMOBILE_UNIT_TEST_CHUNK_FILES, nightly macOS) share one
# lane-wide deadline by design and are not retried; neither is the changed lane.
UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS=60
UNIT_CALIBRATION_TIMEOUT_SECONDS=15

# Runner calibration probe (#10583): a fixed ~50ms CPU/event-loop workload at
# shard start and end. scripts/validate-bun-test-timings.sh reads the samples
# (calibration-*.tsv next to the JUnit reports) to scale the first-sample
# 100ms budget on a starved runner. AUTOMOBILE_RUNNER_CALIBRATION=0 skips it,
# and so does a chunk deadline (nightly macOS chunk lane).
run_runner_calibration() {
  local out="$1" label="$2"
  if [[ "${AUTOMOBILE_RUNNER_CALIBRATION:-1}" == 0 ]]; then
    return 0
  fi
  # Chunked shards share one lane-wide deadline (chunk_deadline, set by
  # run_unit_shards) that a probe's own timeout would overrun on a starved
  # runner, so they run uncalibrated: the gate then keeps the unscaled budget.
  if [[ -n "${chunk_deadline:-}" ]]; then
    return 0
  fi
  # Best effort: a failed or stalled probe only loses this sample; it must
  # never fail or stall the shard, so its status is reported and dropped.
  run_capture_status run_with_timeout "$UNIT_CALIBRATION_TIMEOUT_SECONDS" \
    bun "$ROOT/scripts/lib/runner-calibration.ts" probe "$out" "$label"
  if [[ "$RUN_STATUS" -ne 0 ]]; then
    printf 'test-ts: runner calibration probe failed (%s); continuing without this sample\n' "$label" >&2
  fi
}

# Starts one shard attempt in the background and records its pid. Reads and
# sets the caller's (run_unit_shards) locals through Bash's dynamic scoping.
launch_unit_shard() {
  local shard="$1" attempt="$2" index
  shard_files=()
  shard_number="$shard"
  for ((index = shard - shard_start; index < ${#test_files[@]}; index += worker_count)); do
    shard_files+=("${test_files[$index]}")
  done
  report_name="shard-${shard}.xml"
  if [[ "$shard_mode" == changed ]]; then
    shard_number=$((shard + 1))
  fi

  if [[ "$shard_mode" == coverage ]]; then
    coverage_chunks=(bash "$ROOT/scripts/lib/bun-unit-chunks.sh" "$ROOT" "$runner_os"
      "$coverage_chunk_files" "" "$shard"
      ${coverage_prefix[@]+"${coverage_prefix[@]}"} --)
    if [[ "${TEST_TS_PRINT_CMD:-}" == 1 ]]; then
      printf '%q ' ${coverage_chunks[@]+"${coverage_chunks[@]}"} ${shard_files[@]+"${shard_files[@]}"}
      printf '\n'
      return 0
    fi
  fi

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
    printf '%q ' "${BUN_UNIT_TEST_COMMAND[@]}" \
      ${shard_files[@]+"${shard_files[@]}"}
    printf '\n'
    return 0
  fi

  # Command-scoped exports keep the parent integration defaults independent.
  AUTOMOBILE_TEST_TIMING_LOG="$shard_root/timing-shard-${shard}.ndjson" \
  AUTOMOBILE_WATCHDOG_TIMING_LOG="$shard_root/timing-shard-${shard}.ndjson" \
  AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$shard_root/watchdog-shard-${shard}.txt" \
  AUTOMOBILE_WATCHDOG_LABEL="${shard_mode} shard ${shard_number}" \
  AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$shard_root/shard-${shard}.pgid" \
  AUTOMOBILE_FORCE_PORTABLE_TIMEOUT="${shard_portable_timeout}" \
    run_unit_shard_attempt > "$shard_root/shard-${shard}.log" 2>&1 3>&- &
  pids[shard]=$!
  cleanup_pids+=("$!")
}

# Launches the first attempt of the next queued shard and advances next_shard.
# Reads and sets run_unit_shards' locals through Bash's dynamic scoping.
launch_queued_unit_shard() {
  cleanup_pgid_prefixes+=("$shard_root/shard-${next_shard}.pgid")
  shard_attempts[next_shard]=1
  shard_starts[next_shard]="$(date +%s)"
  launch_unit_shard "$next_shard" 1
  next_shard=$((next_shard + 1))
}

# Runs in the background shell launched above; reads the launcher's dynamic locals.
run_unit_shard_attempt() {
  local shard_pgid_file="${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE:-}"
  if [[ "$shard_mode" == coverage ]]; then
    export AUTOMOBILE_WATCHDOG_LABEL="coverage shard ${shard}/${worker_count}"
  fi
  shard_started="$(date +%s)"
  timing_log="$shard_root/timing-shard-${shard}.ndjson"
  # Coverage is the unit lane too; keep the existing calibration file/label
  # contract so the contention lookup reads this exact attempt's probes.
  local calibration_mode="$shard_mode"
  if [[ "$shard_mode" == coverage ]]; then calibration_mode=unit; fi
  local calibration_file="${AUTOMOBILE_UNIT_JUNIT_DIR:-$shard_root}/calibration-${calibration_mode}-shard-${shard}.tsv"
  local calibration_label="${calibration_mode} shard ${shard} attempt ${attempt}"
  shard_args=(${BUN_UNIT_TEST_COMMAND[@]+"${BUN_UNIT_TEST_COMMAND[@]}"})
  if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
    shard_args+=(
      --reporter junit
      --reporter-outfile "$AUTOMOBILE_UNIT_JUNIT_DIR/$report_name"
    )
  fi
  if [[ "$shard_mode" == coverage ]]; then
    export AUTOMOBILE_CHUNK_COVERAGE_ROOT="$shard_root"
    shard_args=(${coverage_chunks[@]+"${coverage_chunks[@]}"})
  else
    configure_unit_shard_groups "$shard"
  fi
  local shard_budget="${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}"
  if [[ "$shard_mode" == unit && -n "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ]]; then
    # One child owns the sequential loop: the watchdog bounds ALL chunks,
    # including startup/report work, and still signals their process group.
    shard_args=(bash "$ROOT/scripts/lib/bun-unit-chunks.sh" "$ROOT" "$runner_os"
      "$AUTOMOBILE_UNIT_TEST_CHUNK_FILES" "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" "$shard")
    if [[ -n "$chunk_deadline" ]]; then
      shard_budget=$((chunk_deadline - $(date +%s)))
      if [[ "$shard_budget" -le 0 ]]; then
        # The lane deadline passed during discovery/launch, so the watchdog
        # never runs. Leave the snapshot it would have written (write-then-
        # rename, never an empty or partial file) so the artifact says why.
        snapshot_tmp="${AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE}.tmp.$$"
        printf 'chunk deadline expired before %s started (budget %ss; discovery or startup consumed it)\n' \
          "$AUTOMOBILE_WATCHDOG_LABEL" "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" > "$snapshot_tmp"
        mv -f "$snapshot_tmp" "$AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE"
        exit 124
      fi
    fi
  fi
  run_runner_calibration "$calibration_file" "$calibration_label start"
  if [[ -n "$shard_budget" ]]; then
    validate_positive_integer \
      "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
      "$shard_budget"
    shard_status=0
    set +e
    # Bash 3.2 can leak a nested temporary export to children despite the
    # watchdog's unset. Clear the inherited binding before passing it anew.
    unset AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE
    AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$shard_pgid_file" run_with_timeout "$shard_budget" \
      ${shard_args[@]+"${shard_args[@]}"} \
      ${shard_files[@]+"${shard_files[@]}"}
    shard_status=$?
    set -e
  else
    shard_status=0
    ${shard_args[@]+"${shard_args[@]}"} \
      ${shard_files[@]+"${shard_files[@]}"} || shard_status=$?
  fi
  # The parent reaps shards by polling, after the end probe and timing
  # summary, so its clock would overstate the test run (#10583). Record this
  # attempt's own test wall time before the end probe and timing summary.
  printf '%s\n' "$(($(date +%s) - shard_started))" > "$shard_root/shard-${shard}.wall"
  run_runner_calibration "$calibration_file" "$calibration_label end"
  if [[ -s "$timing_log" ]]; then
    bun "$ROOT/scripts/lib/test-file-timings.ts" summary "$timing_log" || true
  fi
  exit "$shard_status"
}

# Best effort, bounded lookup of this shard's exact attempt. Missing/failed
# calibration preserves the existing retry policy; never borrow another probe.
unit_shard_is_contended() {
  local shard="$1"
  if [[ "$shard_mode" == changed ]]; then
    return 1
  fi
  # The retry predicate and final diagnostic immediately share this result;
  # read each attempt once so a second lookup cannot consume its overhead.
  if [[ "$contended_probe_key" != "$shard:${shard_attempts[$shard]}" ]]; then
    contended_probe_key="$shard:${shard_attempts[$shard]}"
    contended_slowdown=""
    local lookup_status caller_options="$-"
    set +e
    contended_slowdown="$(run_with_timeout "$UNIT_CALIBRATION_TIMEOUT_SECONDS" \
      bun "$ROOT/scripts/lib/runner-calibration.ts" shard-attempt-slowdown \
      "${AUTOMOBILE_UNIT_JUNIT_DIR:-$shard_root}" "shard-$shard" "${shard_attempts[$shard]}" 2>/dev/null)"
    lookup_status=$?
    if [[ "$caller_options" == *e* ]]; then set -e; fi
    if [[ "$lookup_status" -ne 0 ]]; then
      contended_slowdown=""
      return 1
    fi
  fi
  if ! [[ "$contended_slowdown" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    return 1
  fi
  if [[ -z "$worst_probe_slowdown" ]] || awk -v slowdown="$contended_slowdown" -v worst="$worst_probe_slowdown" \
    'BEGIN { exit !(slowdown > worst) }'; then
    worst_probe_slowdown="$contended_slowdown"
  fi
  awk -v slowdown="$contended_slowdown" -v threshold="$unit_contended_slowdown" \
    'BEGIN { exit !(slowdown >= threshold) }'
}

# Called once for every reaped unit timeout, before deciding whether to retry.
report_unit_timeout_summary() {
  local shard="$1" sample="no calibration sample"
  if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
    return 0
  fi
  if [[ "$contended_slowdown" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    sample="runner probe slowdown ${contended_slowdown}x (contended threshold ${unit_contended_slowdown}x)"
  fi
  printf -- '- Unit shard %d hit its %ss wall-clock budget (attempt %d); %s.\n' \
    "$shard" "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-unbounded}" "${shard_attempts[$shard]}" "$sample" >> "$GITHUB_STEP_SUMMARY" || true
}

report_starved_unit_lane() {
  local shard message slowdown="n/a"
  for ((shard = shard_start; shard < shard_end; shard += 1)); do
    if [[ "${shard_statuses[$shard]}" -ne 124 || "${shard_attempts[$shard]}" -ne 2 || "${shard_first_statuses[$shard]:-0}" -ne 124 ]]; then
      return 0
    fi
  done
  if [[ -n "$worst_probe_slowdown" ]]; then
    slowdown="${worst_probe_slowdown}x"
  fi
  printf -v message 'RUNNER-STARVED-SUSPECTED: all %d unit shards hit the %s s wall-clock budget on both attempts (worst probe slowdown %s); every shard being slow on a retried runner points at a starved runner, not a code regression.' \
    "$worker_count" "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-unbounded}" "$slowdown"
  printf '%s\n' "$message" >&2
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::error title=Unit lane runner starvation suspected::%s\n' "$message" >&2
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY" || true
    fi
  fi
}

report_contended_unit_shard() {
  local shard="$1" suffix="$2" message
  printf -v message 'RUNNER-CONTENDED: unit shard %d hit its %ss wall-clock budget%s on a starved runner (probe slowdown %sx >= %sx); not retrying on the same runner. Attempt 1 is rerun automatically on a fresh runner; on attempt 2 or later, do not rerun by hand: file or classify it as a new issue.' \
    "$shard" "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" "$suffix" "$contended_slowdown" "$unit_contended_slowdown"
  printf '%s\n' "$message" >&2
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::error title=Unit shard runner contended::%s\n' "$message" >&2
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY" || true
    fi
  fi
}

# Succeeds when a reaped first attempt should be retried (see the arithmetic above).
unit_shard_should_retry() {
  local shard="$1" status="$2" elapsed
  if [[ "$shard_mode" == changed || "$unit_shard_retries" -eq 0 || ( "$shard_mode" == unit && -n "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ) ]]; then
    return 1
  fi
  if [[ "$status" -ne 124 ]] && ! [[ "$status" -ge 129 && "$status" -le 192 ]]; then
    return 1
  fi
  if [[ "$status" -eq 124 ]]; then
    run_capture_status host_load_exceeds_cores "$shard"
    if [[ "$RUN_STATUS" -eq 0 ]]; then return 1; fi
    run_capture_status unit_shard_is_contended "$shard"
    if [[ "$RUN_STATUS" -eq 0 ]]; then return 1; fi
  fi
  if [[ -n "$lane_cap" ]]; then
    elapsed=$(($(date +%s) - lane_start))
    if ((elapsed + AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS + UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS > lane_cap)); then
      printf 'test-ts: not retrying unit shard %d (status %d): a %ss retry at %ss elapsed would pass the %ss lane cap\n' \
        "$shard" "$status" "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$elapsed" "$lane_cap" >&2
      return 1
    fi
  fi
  return 0
}

retry_unit_shard() {
  local shard="$1" status="$2" elapsed reason failing_lines
  shard_first_statuses[shard]="$status"
  elapsed=$(($(date +%s) - shard_starts[shard]))
  if [[ "$status" -eq 124 ]]; then
    reason="hit its ${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-unbounded}s wall-clock budget (exit 124) after ${elapsed}s"
  else
    reason="was killed by signal $((status - 128)) (exit ${status}) after ${elapsed}s"
  fi
  # Starved runners also time out individual tests; surface how many so a
  # retry that hides a real failure is still visible in the attempt-1 log.
  failing_lines="$(grep -c '(fail)' "$shard_root/shard-${shard}.log" 2> /dev/null || true)"
  printf 'RETRY: unit shard %d %s; retrying once with the same budget (attempt 1 logged %s failing test line(s); kept as shard-%d.attempt-1.log)\n' \
    "$shard" "$reason" "${failing_lines:-0}" "$shard" >&2
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::warning title=Unit shard retried (infra exit)::unit shard %d %s; retried once with the same budget. Repeated retries mean the runner is starved or a shard hangs (#10583).\n' \
      "$shard" "$reason" >&2 || true
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- Unit shard %d %s; retried once (#10583).\n' "$shard" "$reason" >> "$GITHUB_STEP_SUMMARY" || true
  fi
  mv "$shard_root/shard-${shard}.log" "$shard_root/shard-${shard}.attempt-1.log"
  if [[ -f "$shard_root/watchdog-shard-${shard}.txt" ]]; then
    mv "$shard_root/watchdog-shard-${shard}.txt" "$shard_root/watchdog-shard-${shard}.attempt-1.txt"
  fi
  if [[ -f "$shard_root/timing-shard-${shard}.ndjson" ]]; then
    mv "$shard_root/timing-shard-${shard}.ndjson" "$shard_root/timing-shard-${shard}.attempt-1.ndjson"
  fi
  if [[ "$shard_mode" == coverage ]]; then
    mkdir -p "$shard_root/attempt-1"
    for file in "$shard_root/shard-${shard}-chunk-"* "$shard_root/shard-${shard}.chunks"; do
      [[ ! -e "$file" ]] || mv "$file" "$shard_root/attempt-1/"
    done
  fi
  rm -f "$shard_root/shard-${shard}.wall"
  # A killed attempt can leave partial reports: the shard's own report and any
  # per-chunk reports (shard-N-iso-K.xml). Match exact names, never shard-N*,
  # which would also delete shard-N0.xml of another shard.
  if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
    rm -f "$AUTOMOBILE_UNIT_JUNIT_DIR/shard-${shard}.xml" \
      "$AUTOMOBILE_UNIT_JUNIT_DIR/shard-${shard}-"*.xml
  fi
  # launch_unit_shard re-derives the shard groups, so the retry runs the same file set.
  shard_attempts[shard]=2
  shard_starts[shard]="$(date +%s)"
  launch_unit_shard "$shard" 2
}

finish_unit_shard() {
  local shard="$1" status="$2" suffix="" number="$1"
  if [[ "$shard_mode" == "changed" ]]; then
    number=$((shard + 1))
  fi
  if [[ "${shard_attempts[$shard]}" -gt 1 ]]; then
    suffix=" after a retry"
  fi
  shard_elapsed_seconds[shard]=$(($(date +%s) - shard_starts[shard]))
  # A killed shard writes no record; keep the reap-time upper bound for it.
  if [[ -f "$shard_root/shard-${shard}.wall" ]]; then
    shard_wall_record="$(< "$shard_root/shard-${shard}.wall")"
    if [[ "$shard_wall_record" =~ ^[0-9]+$ ]]; then
      shard_elapsed_seconds[shard]="$shard_wall_record"
    fi
  fi
  shard_statuses[shard]="$status"
  if [[ "$status" -eq 124 ]]; then
    run_capture_status unit_shard_is_contended "$shard"
    if [[ "$RUN_STATUS" -eq 0 ]]; then
      report_contended_unit_shard "$shard" "$suffix"
    fi
    if [[ "$shard_mode" == coverage ]]; then
      printf 'Coverage test run exceeded its %ss wall-clock budget (shard %d/%d).\n' \
        "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$shard" "$worker_count" >&2
    fi
    printf 'TIMEOUT: %s shard %d exceeded its wall-clock budget%s\n' "$shard_mode" "$number" "$suffix" >&2
    rc=124
  elif [[ "$status" -ne 0 ]]; then
    # Name every failing shard, even beside a timeout, so a real test failure
    # is never hidden behind another shard's infra exit; 124 keeps precedence.
    if [[ "$shard_mode" == coverage ]]; then
      printf 'FAIL: coverage shard %d/%d exited with status %d%s\n' "$number" "$worker_count" "$status" "$suffix" >&2
    else
      printf 'FAIL: %s shard %d exited with status %d%s\n' "$shard_mode" "$number" "$status" "$suffix" >&2
    fi
    if [[ "$rc" -ne 124 ]]; then
      if [[ "$shard_mode" == coverage && "$status" -ge 129 && "$status" -le 192 ]]; then
        # Preserve a terminal infra exit for run-ts-coverage.sh: clean chunk
        # logs plus WriteFailed must never waive an exhausted signal retry.
        rc="$status"
      elif [[ "$rc" -lt 129 || "$rc" -gt 192 ]]; then
        rc=1
      fi
    fi
  elif [[ "$status" -eq 0 && -n "$suffix" ]]; then
    printf 'test-ts: %s shard %d passed on its retry\n' "$shard_mode" "$number" >&2
  fi
}

# Windows uses Bun's native file selection to avoid the 32,767-character
# command-line limit. No POSIX watchdog or infra retry is used in these lanes.
# These helpers share the calling lane's local arrays through dynamic scoping.
launch_windows_test_process() {
  local label="$1" name="$2" index="${#pids[@]}"
  shift 2
  if [[ "${TEST_TS_PRINT_CMD:-}" == 1 ]]; then
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  labels[index]="$label"
  log_names[index]="$name"
  starts[index]="$(date +%s)"
  local had_monitor=0
  case "$-" in *m*) had_monitor=1 ;; esac
  set -m
  "$@" > "$shard_root/$name.log" 2>&1 &
  pids[index]=$!
  cleanup_pids+=("$!")
  printf '%s %s\n' "$!" "$!" > "$shard_root/$name.pgid.$!"
  cleanup_pgid_prefixes+=("$shard_root/$name.pgid")
  if [[ "$had_monitor" -eq 0 ]]; then set +m; fi
}

reap_windows_test_processes() {
  local index status rc=0
  for ((index = 0; index < ${#pids[@]}; index += 1)); do
    status=0
    wait "${pids[$index]}" || status=$?
    forget_cleanup_pid "${pids[$index]}"
    rm -f "$shard_root/${log_names[$index]}.pgid.${pids[$index]}"
    printf 'test-ts: %s wall=%ss status=%s\n' \
      "${labels[$index]}" "$(($(date +%s) - starts[index]))" "$status"
    if [[ "$rc" -eq 0 && "$status" -ne 0 ]]; then
      rc="$status"
    fi
  done
  cleanup_pids=()
  for ((index = 0; index < ${#pids[@]}; index += 1)); do
    printf '\n==> %s\n' "${labels[$index]}"
    cat "$shard_root/${log_names[$index]}.log"
  done
  return "$rc"
}

run_windows_unit_shards() {
  local shard shard_root="${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}/test-ts-unit-shards"
  add_macos_only_bun_config unit
  local pids=() labels=() log_names=() starts=()
  if [[ "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
    rm -rf "$shard_root"
    mkdir_spotlight_excluded_within "$ROOT" "$shard_root"
  fi
  for ((shard = 1; shard <= unit_workers; shard += 1)); do
    launch_windows_test_process "unit shard $shard/$unit_workers" "shard-$shard" \
      "${unit_args[@]}" "--shard=$shard/$unit_workers"
  done
  reap_windows_test_processes
}

run_windows_integration_shards() {
  local workers="${AUTOMOBILE_INTEGRATION_TEST_WORKERS:-3}"
  local tier_file="${AUTOMOBILE_INTEGRATION_SAFE_TIER_FILE:-$ROOT/test/integration-safe-tier.txt}"
  local shard safe_workers path
  local shard_root="${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}/test-ts-integration-shards"
  local pids=() labels=() log_names=() starts=() unsafe_paths=() ignore_args=()
  validate_positive_integer "AUTOMOBILE_INTEGRATION_TEST_WORKERS" "$workers"
  if [[ "$workers" -eq 1 ]]; then
    run_test_command "${integration_args[@]}" .integration.test.ts
    return $?
  fi
  if [[ ! -f "$tier_file" ]]; then
    echo "Safe-tier list not found: ${tier_file}" >&2
    return 2
  fi
  # shellcheck source=scripts/lib/integration-safe-tier.sh
  source "$ROOT/scripts/lib/integration-safe-tier.sh"
  while IFS= read -r path; do
    if [[ -f "$path" ]]; then
      unsafe_paths+=("$path")
      ignore_args+=(--path-ignore-patterns "$path")
    fi
  done < <(integration_tier_paths "$tier_file" unsafe | macos_only_filter)
  if [[ "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
    rm -rf "$shard_root"
    mkdir_spotlight_excluded_within "$ROOT" "$shard_root"
  fi
  safe_workers="$workers"
  if [[ "${#unsafe_paths[@]}" -gt 0 ]]; then
    safe_workers=$((workers - 1))
    launch_windows_test_process "integration unsafe" unsafe \
      "${integration_args[@]}" "${unsafe_paths[@]+"${unsafe_paths[@]}"}"
  fi
  for ((shard = 1; shard <= safe_workers; shard += 1)); do
    launch_windows_test_process "integration safe $shard/$safe_workers" "safe-$shard" \
      "${integration_args[@]}" "${ignore_args[@]+"${ignore_args[@]}"}" \
      "--shard=$shard/$safe_workers" .integration.test.ts
  done
  reap_windows_test_processes
}

run_unit_shards() {
  local shard_mode="$1"
  local changed_ref="${2:-}"
  local unit_selection_file=""
  # AUTOMOBILE_TEST_TS_SCRATCH_DIR relocates the shard scratch tree so the bats
  # suite can run this lane hermetically (per-test dir) instead of serially.
  local shard_root="${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}/test-ts-${shard_mode}-shards"
  local file index shard shard_number worker_count max_running next_shard rc shard_status report_name
  local shard_start=0 shard_end
  local coverage_chunks=()
  local shard_portable_timeout=1
  if [[ "$shard_mode" == coverage ]]; then
    shard_start=1
    shard_root="$coverage_root/shards"
  fi
  local lane_start lane_elapsed physical_cores lane_cap="" attempts_note
  local shard_wall_record
  local test_files=()
  local shared_files=()
  local isolated_files=()
  local shared_total=0
  local shard_files=()
  local pids=()
  local shard_starts=()
  local shard_attempts=()
  local shard_elapsed_seconds=()
  local shard_statuses=()
  local shard_first_statuses=()
  local retry_shards=()
  local pending_shards=()
  local still_pending=()
  local reaped_any
  local unit_shard_retries="${AUTOMOBILE_UNIT_SHARD_RETRIES:-1}"
  local unit_contended_slowdown="${AUTOMOBILE_UNIT_CONTENDED_SLOWDOWN:-2.5}"
  local contended_slowdown="" contended_probe_key="" worst_probe_slowdown=""
  if ! [[ "$unit_contended_slowdown" =~ ^[0-9]+(\.[0-9]+)?$ && "$unit_contended_slowdown" =~ [1-9] ]]; then
    echo "AUTOMOBILE_UNIT_CONTENDED_SLOWDOWN must be a positive number, got: ${unit_contended_slowdown}" >&2
    return 2
  fi
  local reap_poll_seconds="${AUTOMOBILE_UNIT_SHARD_POLL_SECONDS:-0.2}"
  if [[ "$unit_shard_retries" != 0 && "$unit_shard_retries" != 1 ]]; then
    echo "AUTOMOBILE_UNIT_SHARD_RETRIES must be 0 or 1, got: ${unit_shard_retries}" >&2
    return 2
  fi
  if ! [[ "$reap_poll_seconds" =~ ^[0-9]+(\.[0-9]+)?$ && "$reap_poll_seconds" =~ [1-9] ]]; then
    echo "AUTOMOBILE_UNIT_SHARD_POLL_SECONDS must be a positive number of seconds, got: ${reap_poll_seconds}" >&2
    return 2
  fi
  lane_start=$(date +%s)
  local chunk_deadline=""
  if [[ "$shard_mode" == unit && -n "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" && -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    validate_positive_integer "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
    chunk_deadline=$(($(date +%s) + AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS))
  fi
  # shellcheck source=scripts/ios/run_with_timeout.sh
  source "$ROOT/scripts/ios/run_with_timeout.sh"

  if [[ "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
    rm -rf "$shard_root"
    mkdir_spotlight_excluded_within "$ROOT" "$shard_root"
  fi
  if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
    rm -rf "$AUTOMOBILE_UNIT_JUNIT_DIR"
    mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
  fi
  if [[ "$shard_mode" == changed ]]; then
    # Print-only runs skip the scratch reset above but still need somewhere to
    # hold the resolved list.
    mkdir_spotlight_excluded_within "$ROOT" "$shard_root"
    unit_selection_file="$shard_root/selected-unit.txt"
    # Resolve once before sharding. The selector unions a parse-only Bun graph
    # with affectedTests' reference/always-run extras; uncertain edges select
    # all units rather than silently narrowing Bun --changed coverage (#13909).
    local select_timeout="${AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS:-120}"
    validate_positive_integer "AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS" "$select_timeout"
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$select_timeout" TEST_TS_PRINT_CMD=0 \
      run_test_command bun "$ROOT/scripts/lib/changedUnitTests.ts" "$changed_ref" > "$unit_selection_file"
  fi
  if [[ "$shard_mode" == coverage ]]; then
    test_files=(${coverage_files[@]+"${coverage_files[@]}"})
  else
    while IFS= read -r file; do
      shared_files+=("$file")
    done < <(shared_process_unit_files)
    shared_total="${#shared_files[@]}"
    # Both lists keep discovery order, so one merge walk separates them. Shared
    # files go first so round-robin spreads both groups evenly across shards.
    index=0
    while IFS= read -r file; do
      if [[ "$index" -lt "$shared_total" && "$file" == "${shared_files[$index]}" ]]; then
        index=$((index + 1))
      else
        isolated_files+=("$file")
      fi
    done < <(discover_unit_test_files)
    test_files=(${shared_files[@]+"${shared_files[@]}"} ${isolated_files[@]+"${isolated_files[@]}"})
  fi

  if [[ "${#test_files[@]}" -eq 0 ]]; then
    if [[ "$shard_mode" == changed ]]; then echo 'No changed unit tests'; return 0; fi
    echo "No unit test files discovered" >&2
    return 1
  fi
  if [[ "$shard_mode" == unit ]]; then
    printf 'test-ts: unit lane shared_files=%s isolated_files=%s\n' \
      "$shared_total" "${#isolated_files[@]}" >&2
  fi

  if [[ "$shard_mode" == coverage ]]; then
    # The shard count is explicit configuration (AUTOMOBILE_COVERAGE_SHARDS) and
    # shapes the partition, so it is never reduced. The acquired host slots bound
    # how many of those fixed shards run at once instead (#14448): the rest wait
    # for a running shard to finish. Like the unit lane, zero acquired slots
    # still runs one shard at a time rather than every shard unslotted.
    max_running="$coverage_shards"
    if [[ "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
      cap_unit_workers "$coverage_shards"
      max_running="$capped_workers"
    fi
    worker_count="$coverage_shards"
  else
    cap_unit_workers "$unit_workers"
    worker_count="$capped_workers"
    max_running="$worker_count"
  fi
  if [[ "$worker_count" -gt "${#test_files[@]}" ]]; then
    worker_count="${#test_files[@]}"
  fi
  if [[ "$max_running" -gt "$worker_count" ]]; then
    max_running="$worker_count"
  fi

  if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    validate_positive_integer \
      "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
      "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
    lane_cap="${AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS:-$((2 * (AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS + UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS)))}"
    validate_positive_integer "AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS" "$lane_cap"
  fi

  shard_end=$((shard_start + worker_count))

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" && "$shard_mode" == "unit" ]]; then
    printf \
      'bun test --isolate --no-orphans --path-ignore-patterns %q --path-ignore-patterns %q --shards=%s\n' \
      "**/*.integration.test.ts" \
      "test/stress/**" \
      "$worker_count"
    return 0
  fi

  if [[ "$max_running" -lt "$worker_count" ]]; then
    printf 'test-ts: %s shards=%s running at most %s at once (host slots)\n' \
      "$shard_mode" "$worker_count" "$max_running" >&2
  fi
  next_shard="$shard_start"
  while [[ "$next_shard" -lt "$shard_end" && "$((next_shard - shard_start))" -lt "$max_running" ]]; do
    launch_queued_unit_shard
    pending_shards+=("$((next_shard - 1))")
  done

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
    return 0
  fi

  rc=0
  # Reap attempts in completion order (#10644): a shard whose first attempt
  # ends is reaped (and, on an infra exit, retried) at once instead of after
  # every lower-index shard, so its retry window is judged at its real end
  # time. Bash 3.2 (macOS) has no `wait -n`, so poll the live attempts with
  # `kill -0`; Bash reaps exited children on SIGCHLD and `wait PID` still
  # returns the remembered status. The interval adds at most one poll of
  # latency per reap, well inside UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS.
  # A retry reuses its shard's running seat; a finished shard hands its seat
  # to the next queued one, so at most max_running attempts are ever live.
  while [[ "${#pending_shards[@]}" -gt 0 ]]; do
    still_pending=()
    reaped_any=0
    for index in "${pending_shards[@]}"; do
      if kill -0 "${pids[$index]}" 2> /dev/null; then
        still_pending+=("$index")
        continue
      fi
      reaped_any=1
      shard_status=0
      wait "${pids[$index]}" || shard_status=$?
      forget_cleanup_pid "${pids[$index]}"
      if [[ "$shard_mode" != changed && "$shard_status" -eq 124 ]]; then
        run_capture_status unit_shard_is_contended "$index"
        report_unit_timeout_summary "$index"
      fi
      RUN_STATUS=1
      if [[ "${shard_attempts[$index]}" -eq 1 ]]; then
        run_capture_status unit_shard_should_retry "$index" "$shard_status"
      fi
      if [[ "$RUN_STATUS" -eq 0 ]]; then
        retry_unit_shard "$index" "$shard_status"
        retry_shards+=("$index")
        still_pending+=("$index")
        continue
      fi
      finish_unit_shard "$index" "$shard_status"
      if [[ "$next_shard" -lt "$shard_end" ]]; then
        launch_queued_unit_shard
        still_pending+=("$((next_shard - 1))")
      fi
    done
    pending_shards=(${still_pending[@]+"${still_pending[@]}"})
    if [[ "$reaped_any" -eq 0 && "${#pending_shards[@]}" -gt 0 ]]; then
      sleep "$reap_poll_seconds"
    fi
  done

  if [[ "$shard_mode" != changed ]]; then
    lane_elapsed=$(($(date +%s) - lane_start))
    for ((shard = shard_start; shard < shard_end; shard += 1)); do
      attempts_note=""
      if [[ "${shard_attempts[$shard]}" -gt 1 ]]; then
        attempts_note=" attempts=${shard_attempts[$shard]}"
      fi
      printf 'test-ts: unit shard %d/%d wall=%ss status=%s%s\n' \
        "$((shard - shard_start + 1))" "$worker_count" \
        "${shard_elapsed_seconds[$shard]}" "${shard_statuses[$shard]}" "$attempts_note" >&2
    done
    printf 'test-ts: unit shards total wall=%ss status=%s retried=%s\n' \
      "$lane_elapsed" "$rc" "${#retry_shards[@]}" >&2
    report_starved_unit_lane
  fi

  for ((shard = shard_start; shard < shard_end; shard += 1)); do
    if [[ -f "$shard_root/shard-${shard}.attempt-1.log" ]]; then
      printf '\n==> TypeScript %s shard %d/%d (attempt 1 of 2, retried)\n' "$shard_mode" "$((shard - shard_start + 1))" "$worker_count"
      command cat "$shard_root/shard-${shard}.attempt-1.log"
    fi
    printf '\n==> TypeScript %s shard %d/%d\n' "$shard_mode" "$((shard - shard_start + 1))" "$worker_count"
    command cat "$shard_root/shard-${shard}.log"
  done
  cleanup_pids=()
  return "$rc"
}

parallel_workers="$unit_workers"
if [[ ( "$mode" == unit || "$mode" == changed ) && "$runner_os" != Windows &&
      ( "${#unit_test_paths[@]}" -gt 0 || "${#passthrough_args[@]}" -gt 0 ) ]]; then
  target_demand="$unit_workers"
  if [[ "${#unit_test_paths[@]}" -gt 0 && "$target_demand" -gt "${#unit_test_paths[@]}" ]]; then
    target_demand="${#unit_test_paths[@]}"
  fi
  cap_unit_workers "$target_demand"
  parallel_workers="$capped_workers"
fi
if [[ "$mode" == "coverage" ]]; then
  # Keep Bun's in-process parallelism off for the coverage reporter and Linux
  # epoll-backed streams. Coverage shards use separate processes and log files.
  parallel_workers=1
fi

unit_args=(
  bun test
  --timeout "$per_test_timeout_ms"
  --path-ignore-patterns "**/*.integration.test.ts"
  --path-ignore-patterns "test/stress/**"
)

if [[ "$runner_os" != "Windows" ]]; then
  unit_args+=(--isolate --no-orphans "--parallel=${parallel_workers}")
fi

case "$mode" in
  unit)
    if [[ -n "${AUTOMOBILE_UNIT_RANDOM_SEED:-}" ]]; then
      run_randomized_unit
      exit $?
    fi
    printf 'test-ts: unit lane cores=%s workers=%s\n' "$cores" "$unit_workers" >&2
    physical_cores="$(sysctl -n hw.physicalcpu 2>/dev/null || nproc 2>/dev/null || true)"
    if ! [[ "$physical_cores" =~ ^[0-9]+$ ]] || [[ "$physical_cores" -lt 1 ]]; then
      physical_cores=unknown
    fi
    printf 'test-ts: unit lane logical_cores=%s physical_cores=%s workers=%s shards=%s\n' \
      "$cores" "$physical_cores" "$unit_workers" "$unit_workers" >&2
    if [[ "${#unit_test_paths[@]}" -gt 0 && ( "${#integration_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Unit test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "$has_test_targets" -eq 1 ]]; then
      echo "No unit test paths were selected." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "${#passthrough_args[@]}" -eq 0 && "$runner_os" == "Windows" && "$unit_workers" -gt 1 && -z "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
      run_windows_unit_shards
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "${#passthrough_args[@]}" -eq 0 && "$runner_os" != "Windows" ]]; then
      run_unit_shards unit
    else
      add_macos_only_bun_config unit
      run_test_command \
        "${unit_args[@]}" \
        "${unit_test_paths[@]+"${unit_test_paths[@]}"}" \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    ;;
  changed)
    if [[ "${#unit_test_paths[@]}" -gt 0 && ( "${#integration_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Unit test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "$has_test_targets" -eq 1 ]]; then
      echo "No unit test paths were selected." >&2
      exit 2
    fi
    changed_ref="${AUTOMOBILE_UNIT_TEST_BASE_REF:-origin/main}"
    if [[ "${#unit_test_paths[@]}" -eq 0 && "${#passthrough_args[@]}" -eq 0 && "$runner_os" != "Windows" ]]; then
      run_unit_shards changed "$changed_ref"
      exit $?
    fi
    add_macos_only_bun_config unit
    changed_args=("${unit_args[@]}")
    if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
      rm -rf "$AUTOMOBILE_UNIT_JUNIT_DIR"
      mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
      changed_args+=(
        --reporter junit
        --reporter-outfile "$AUTOMOBILE_UNIT_JUNIT_DIR/changed.xml"
      )
    fi
    run_test_command \
      "${changed_args[@]}" \
      "--changed=${changed_ref}" \
      "${unit_test_paths[@]+"${unit_test_paths[@]}"}" \
      "${passthrough_args[@]+"${passthrough_args[@]}"}"
    ;;
  integration)
    integration_args=(bun test --isolate --timeout "$per_test_timeout_ms")
    add_macos_only_bun_config integration
    transport_selected=false
    integration_main_paths=()
    for integration_path in "${integration_test_paths[@]+"${integration_test_paths[@]}"}"; do
      if [[ "$integration_path" == test/server/proxyServerTransportFailure.integration.test.ts ]]; then
        transport_selected=true
      else
        integration_main_paths+=("$integration_path")
      fi
    done
    if [[ "$runner_os" != "Windows" ]]; then
      mkdir_spotlight_excluded scratch
      # These assignments run in the parent shell, independent of unit shards.
      export AUTOMOBILE_TEST_TIMING_LOG="${AUTOMOBILE_TEST_TIMING_LOG:-scratch/integration-file-timings-$$.ndjson}"
      export AUTOMOBILE_WATCHDOG_TIMING_LOG="${AUTOMOBILE_WATCHDOG_TIMING_LOG:-$AUTOMOBILE_TEST_TIMING_LOG}"
      export AUTOMOBILE_WATCHDOG_LABEL="${AUTOMOBILE_WATCHDOG_LABEL:-integration test}"
      integration_args+=(--no-orphans --preload "$ROOT/test/setup/fileTimingProbe.ts")
    fi
    if [[ "${#integration_test_paths[@]}" -gt 0 && ( "${#unit_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Integration test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#integration_test_paths[@]}" -gt 0 && "$transport_selected" == false ]]; then
      run_test_command \
        "${integration_args[@]}" \
        "${integration_test_paths[@]+"${integration_test_paths[@]}"}" \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
    elif [[ "$has_test_targets" -eq 0 || "$transport_selected" == true ]]; then
      coverage_requested=false
      long_lived=false
      for passthrough_arg in "${passthrough_args[@]+"${passthrough_args[@]}"}"; do
        case "$passthrough_arg" in
          --coverage|--coverage=*) coverage_requested=true ;;
          --watch|--hot|--inspect-wait|--inspect-brk|--inspect-wait=*|--inspect-brk=*) long_lived=true ;;
        esac
      done
      if [[ "${AUTOMOBILE_TEST_MODE:-}" == true && "$runner_os" != "Windows" &&
        "$coverage_requested" == false && "$long_lived" == false ]]; then
        for ((bail_index = 0; bail_index < ${#passthrough_args[@]}; bail_index += 1)); do
          bail_count=""
          case "${passthrough_args[$bail_index]}" in
            --bail) bail_count="${passthrough_args[$((bail_index + 1))]:-}" ;;
            --bail=*) bail_count="${passthrough_args[$bail_index]#--bail=}" ;;
          esac
          if [[ "$bail_count" =~ ^[0-9]+$ ]]; then
            significant_bail="${bail_count#"${bail_count%%[!0]*}"}"
            significant_bail="${significant_bail:-0}"
            if [[ "$significant_bail" == ??* || "$significant_bail" == [2-9] ]]; then
              echo "--bail=$bail_count cannot be used with AUTOMOBILE_TEST_MODE=true per-file runs; run without AUTOMOBILE_TEST_MODE for a shared numeric bail limit." >&2
              exit 2
            fi
          fi
        done
      fi
      if [[ "$runner_os" == "Windows" && "$has_test_targets" -eq 0 && "$coverage_requested" == false && "$long_lived" == false && "${#passthrough_args[@]}" -eq 0 && -z "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
        run_windows_integration_shards
      elif [[ "$runner_os" == "Windows" || "$coverage_requested" == true || "$long_lived" == true ]]; then
        # Coverage stays in one process so Bun writes a complete LCOV
        # report rather than overwriting the transport suite's first report.
        if [[ "$has_test_targets" -eq 0 ]]; then
          run_test_command "${integration_args[@]}" ".integration.test.ts" \
            "${passthrough_args[@]+"${passthrough_args[@]}"}"
        else
          run_test_command "${integration_args[@]}" \
            "${integration_test_paths[@]+"${integration_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
        fi
      else
        # This MCP transport suite can stall the Linux runner after earlier suites
        # have run, even with Bun's per-file isolation. Give it a fresh process and
        # a short deadline so a regression cannot consume the whole matrix job.
        transport_suite_timeout="${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-60}"
        validate_positive_integer "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$transport_suite_timeout"
        integration_wall_timeout="$transport_suite_timeout"
        integration_started_at="$(date +%s)"
        if ((transport_suite_timeout > 60)); then
          transport_suite_timeout=60
        fi
        transport_args=("${passthrough_args[@]+"${passthrough_args[@]}"}")
        main_args=("${passthrough_args[@]+"${passthrough_args[@]}"}")
        report_outfile=""
        for ((report_index = 0; report_index < ${#transport_args[@]}; report_index += 1)); do
          if [[ "${transport_args[$report_index]}" == --reporter-outfile ]]; then
            report_outfile="${transport_args[$((report_index + 1))]}"
            report_arg_index=$((report_index + 1))
            report_arg_prefix=""
            break
          elif [[ "${transport_args[$report_index]}" == --reporter-outfile=* ]]; then
            report_outfile="${transport_args[$report_index]#--reporter-outfile=}"
            report_arg_index="$report_index"
            report_arg_prefix="--reporter-outfile="
            break
          fi
        done
        if [[ -n "$report_outfile" ]]; then
          report_dir="$(mktemp -d)"
          exit_report_dir="$report_dir"
          transport_args[report_arg_index]="${report_arg_prefix}$report_dir/transport.xml"
          main_args[report_arg_index]="${report_arg_prefix}$report_dir/main.xml"
        fi
        fail_fast=false
        for ((bail_index = 0; bail_index < ${#passthrough_args[@]}; bail_index += 1)); do
          case "${passthrough_args[$bail_index]}" in
            --bail)
              bail_count="${passthrough_args[$((bail_index + 1))]:-}"
              if [[ ! "$bail_count" =~ ^[0-9]+$ ]] || ((bail_count <= 1)); then
                fail_fast=true
              fi
              ;;
            --bail=*)
              bail_count="${passthrough_args[$bail_index]#--bail=}"
              if [[ "$bail_count" =~ ^[0-9]+$ ]] && ((bail_count <= 1)); then
                fail_fast=true
              fi
              ;;
          esac
        done
        transport_status=0
        # A failed process may still write a useful JUnit report. Run the
        # remaining files unless the caller explicitly requested fail-fast.
        AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$transport_suite_timeout" run_capture_status run_test_command \
          "${integration_args[@]}" \
          test/server/proxyServerTransportFailure.integration.test.ts \
          "${transport_args[@]+"${transport_args[@]}"}"
        transport_status="$RUN_STATUS"
        if [[ "${transport_status}" -ne 0 ]]; then
          if [[ "$fail_fast" == true ]]; then
            if [[ -n "$report_outfile" && -f "$report_dir/transport.xml" ]]; then
              cp "$report_dir/transport.xml" "$report_outfile"
            fi
            exit "$transport_status"
          fi
        fi
        if [[ "$has_test_targets" -eq 1 && "${#integration_main_paths[@]}" -eq 0 ]]; then
          if [[ -n "$report_outfile" && -f "$report_dir/transport.xml" ]]; then
            cp "$report_dir/transport.xml" "$report_outfile"
          fi
          exit "$transport_status"
        fi
        integration_remaining=$((integration_wall_timeout - ($(date +%s) - integration_started_at)))
        if ((integration_remaining <= 0)); then
          if [[ -n "$report_outfile" && -f "$report_dir/transport.xml" ]]; then
            cp "$report_dir/transport.xml" "$report_outfile"
          fi
          echo "Integration test run exceeded its ${integration_wall_timeout}s wall-clock budget." >&2
          exit 124
        fi
        main_status=0
        if [[ "$has_test_targets" -eq 0 ]]; then
          main_targets=(--path-ignore-patterns "**/proxyServerTransportFailure.integration.test.ts" ".integration.test.ts")
        else
          main_targets=("${integration_main_paths[@]+"${integration_main_paths[@]}"}")
        fi
        per_file_reports=()
        if [[ "${AUTOMOBILE_TEST_MODE:-}" == true ]]; then
          # Bun --isolate refreshes globals, but native handles remain in the
          # shared process. CI has stalled in unrelated files after earlier
          # suites ran, so give each file a fresh process.
          if [[ "$has_test_targets" -eq 0 ]]; then
            main_targets=()
            while IFS= read -r integration_file; do
              if [[ "$integration_file" != test/server/proxyServerTransportFailure.integration.test.ts ]]; then
                main_targets+=("$integration_file")
              fi
            done < <(find test -type f -name '*.integration.test.ts' | LC_ALL=C sort | macos_only_filter)
            if (( ${#main_targets[@]} == 0 )); then
              echo "No integration test files were found." >&2
              exit 2
            fi
          fi
          main_index=0
          for integration_file in "${main_targets[@]}"; do
            integration_remaining=$((integration_wall_timeout - ($(date +%s) - integration_started_at)))
            if ((integration_remaining <= 0)); then
              echo "Integration test run exceeded its ${integration_wall_timeout}s wall-clock budget." >&2
              main_status=124
              break
            fi
            file_timeout="$integration_remaining"
            if ((file_timeout > 60)); then file_timeout=60; fi
            file_args=("${main_args[@]+"${main_args[@]}"}")
            if [[ -n "$report_outfile" ]]; then
              file_report="$report_dir/main-${main_index}.xml"
              file_args[report_arg_index]="${report_arg_prefix}${file_report}"
            fi
            file_status=0
            AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$file_timeout" run_capture_status run_test_command \
              "${integration_args[@]}" "$integration_file" "${file_args[@]+"${file_args[@]}"}"
            file_status="$RUN_STATUS"
            if [[ -n "$report_outfile" && -f "$file_report" ]]; then
              per_file_reports+=("$file_report")
            fi
            if ((file_status != 0)); then
              if ((main_status == 0 || file_status == 124)); then main_status="$file_status"; fi
              if ((file_status == 124)) || [[ "$fail_fast" == true ]]; then break; fi
            fi
            main_index=$((main_index + 1))
          done
        else
          AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$integration_remaining" run_capture_status run_test_command \
            "${integration_args[@]}" \
            "${main_targets[@]}" \
            "${main_args[@]+"${main_args[@]}"}"
          main_status="$RUN_STATUS"
        fi
        if [[ -n "$report_outfile" && "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
          if (( ${#per_file_reports[@]} > 0 )); then
            if [[ -f "$report_dir/transport.xml" ]]; then
              per_file_reports=("$report_dir/transport.xml" "${per_file_reports[@]}")
            fi
            if (( ${#per_file_reports[@]} > 1 )); then
              bun scripts/lib/merge-junit-reports.ts "$report_outfile" "${per_file_reports[@]}"
            else
              cp "${per_file_reports[0]}" "$report_outfile"
            fi
          elif [[ -f "$report_dir/transport.xml" && -f "$report_dir/main.xml" ]]; then
            bun scripts/lib/merge-junit-reports.ts "$report_outfile" \
              "$report_dir/transport.xml" "$report_dir/main.xml"
          elif [[ -f "$report_dir/transport.xml" ]]; then
            cp "$report_dir/transport.xml" "$report_outfile"
          elif [[ -f "$report_dir/main.xml" ]]; then
            cp "$report_dir/main.xml" "$report_outfile"
          fi
        fi
        if ((transport_status == 124 || main_status == 124)); then exit 124; fi
        if ((transport_status != 0)); then exit "$transport_status"; fi
        if ((main_status != 0)); then exit "$main_status"; fi
      fi
    else
      echo "No integration test paths were selected." >&2
      exit 2
    fi
    ;;
  stress)
    if [[ "${#stress_test_paths[@]}" -gt 0 && ( "${#unit_test_paths[@]}" -gt 0 || "${#integration_test_paths[@]}" -gt 0 ) ]]; then
      echo "Stress test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#stress_test_paths[@]}" -gt 0 ]]; then
      run_test_command \
        bun test --timeout "$per_test_timeout_ms" \
        "${stress_test_paths[@]+"${stress_test_paths[@]}"}" \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
    elif [[ "$has_test_targets" -eq 0 ]]; then
      run_test_command \
        bun test --timeout "$per_test_timeout_ms" \
        test/stress \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
    else
      echo "No stress test paths were selected." >&2
      exit 2
    fi
    ;;
  coverage)
    if [[ "${#unit_test_paths[@]}" -gt 0 && ( "${#integration_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Unit test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "$has_test_targets" -eq 1 ]]; then
      echo "No unit test paths were selected." >&2
      exit 2
    fi
    # Chunked coverage (#10213). Under --isolate one `bun test --coverage` process
    # pays isolate overhead that grows with its age: RSS rises ~10 MB per file
    # (4-5 GB by file ~330, ~9 GB by file ~870) and the last files of a process
    # cost seconds each. More concurrent processes do not help: four shards of
    # one process each exhausted a 16.8 GB runner by ~200 s, stalled every shard
    # together on swap and ran past the budget. So concurrency stays low (2
    # shard processes, within the cores - 1 rule above) and each shard recycles
    # its Bun process every AUTOMOBILE_COVERAGE_CHUNK_FILES files, the way the
    # unit lane's AUTOMOBILE_UNIT_TEST_CHUNK_FILES does. 50 files peaked at
    # 1.25-1.45 GB per process (100 files: 2.1-2.3 GB, one 222-file process:
    # 3.1 GB) on a 444-file sample, and ran faster. Each chunk writes its own
    # lcov/JUnit; they are merged below. The wall-clock budget bounds each
    # shard's whole chunk sequence, not a single chunk.
    # AUTOMOBILE_TEST_TS_COVERAGE_DIR relocates the coverage tree so the bats suite can drive this
    # lane hermetically; CI and local runs keep the default "coverage".
    coverage_root="${AUTOMOBILE_TEST_TS_COVERAGE_DIR:-coverage}"
    coverage_shards="${AUTOMOBILE_COVERAGE_SHARDS:-2}"
    coverage_chunk_files="${AUTOMOBILE_COVERAGE_CHUNK_FILES-50}"
    validate_positive_integer "AUTOMOBILE_COVERAGE_SHARDS" "$coverage_shards"
    validate_positive_integer "AUTOMOBILE_COVERAGE_CHUNK_FILES" "$coverage_chunk_files"
    if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
      validate_positive_integer "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
        "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
    fi
    coverage_files=()
    if [[ "${#unit_test_paths[@]}" -gt 0 ]]; then
      coverage_files=("${unit_test_paths[@]}")
    else
      while IFS= read -r file; do
        coverage_files+=("$file")
      done < <(discover_unit_test_files)
    fi
    if [[ "${#coverage_files[@]}" -eq 0 ]]; then
      echo "No unit test files discovered" >&2
      exit 1
    fi
    if [[ "$coverage_shards" -gt "${#coverage_files[@]}" ]]; then
      coverage_shards="${#coverage_files[@]}"
    fi
    # Everything but the per-chunk --config/--reporter flags, which the chunker adds.
    coverage_prefix=(
      "${unit_args[@]}"
      --coverage --coverage-reporter=lcov
      "${passthrough_args[@]+"${passthrough_args[@]}"}"
    )
    if [[ "$runner_os" != "Windows" ]]; then
      # Per-file start/end events with RSS, appended to one timing log per shard
      # (every chunk of the shard) so the coverage artifact ties a stall to
      # memory. The probe only appends to a file.
      coverage_prefix+=(--preload "$ROOT/test/setup/fileTimingProbe.ts")
    fi
    if [[ "${TEST_TS_PRINT_CMD:-}" != "1" ]]; then
      rm -rf "$coverage_root"
      mkdir_spotlight_excluded_within "$ROOT" "$coverage_root"
      mkdir -p "$coverage_root/shards"
    fi
    # Coverage uses the unit shard supervisor too: the same 720s attempts,
    # 1560s lane cap, infra-only retry, probes, summary and contention dispatch.
    run_capture_status run_unit_shards coverage
    if [[ "$RUN_STATUS" -ne 0 ]]; then exit "$RUN_STATUS"; fi
    if [[ "${TEST_TS_PRINT_CMD:-}" == 1 ]]; then exit 0; fi
    coverage_lcov_files=()
    coverage_junit_files=()
    for ((coverage_shard = 1; coverage_shard <= coverage_shards; coverage_shard += 1)); do
      coverage_manifest="${coverage_root}/shards/shard-${coverage_shard}.chunks"
      if [[ ! -f "$coverage_manifest" ]]; then
        echo "FAIL: coverage shard ${coverage_shard}/${coverage_shards} wrote no chunk manifest" >&2
        exit 1
      fi
      coverage_chunk_total="$(< "$coverage_manifest")"
      for ((coverage_chunk = 1; coverage_chunk <= coverage_chunk_total; coverage_chunk += 1)); do
        coverage_dir="${coverage_root}/shards/shard-${coverage_shard}-chunk-${coverage_chunk}"
        bash scripts/ci/verify-ts-coverage-output.sh "$coverage_dir"
        coverage_lcov_files+=("${coverage_dir}/lcov.info")
        coverage_junit_files+=("${coverage_dir}.xml")
      done
    done
    if [[ "${#coverage_lcov_files[@]}" -eq 1 ]]; then
      cp "${coverage_lcov_files[0]}" "${coverage_root}/lcov.info"
      cp "${coverage_junit_files[0]}" "${coverage_root}/junit.xml"
    else
      bun scripts/lib/merge-lcov.ts "${coverage_root}/lcov.info" "${coverage_lcov_files[@]+"${coverage_lcov_files[@]}"}"
      bun scripts/lib/merge-junit-reports.ts "${coverage_root}/junit.xml" "${coverage_junit_files[@]+"${coverage_junit_files[@]}"}"
    fi
    ;;
  all)
    if [[ "$has_test_targets" -eq 0 || "${#unit_test_paths[@]}" -gt 0 ]]; then
      run_managed_command "$0" unit "${unit_test_paths[@]+"${unit_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    if [[ "$has_test_targets" -eq 0 || "${#integration_test_paths[@]}" -gt 0 ]]; then
      run_managed_command "$0" integration "${integration_test_paths[@]+"${integration_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    if [[ "$has_test_targets" -eq 0 || "${#stress_test_paths[@]}" -gt 0 ]]; then
      run_managed_command "$0" stress "${stress_test_paths[@]+"${stress_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    ;;
  *)
    echo "Usage: scripts/test-ts.sh {unit|changed|integration|stress|coverage|all} [bun-test-args...]" >&2
    exit 2
    ;;
esac
