#!/usr/bin/env bash
#
# Canonical Bun test-lane runner.
#
#   unit        Hermetic *.test.ts tests, excluding integration and stress.
#               Files on test/shared-process-allowlist.txt share one process
#               per shard; the rest run with --isolate (#10583).
#   changed     Unit tests affected by worktree/ref changes (local feedback).
#   integration Real-I/O *.integration.test.ts tests.
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
# shellcheck source=scripts/lib/bun-unit-test.sh disable=SC1091
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

validate_positive_integer "AUTOMOBILE_UNIT_TEST_WORKERS" "$unit_workers"
if [[ "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES+x}" == x ]]; then
  validate_positive_integer "AUTOMOBILE_UNIT_TEST_CHUNK_FILES" "$AUTOMOBILE_UNIT_TEST_CHUNK_FILES"
fi
validate_positive_integer "AUTOMOBILE_TEST_TIMEOUT_MS" "$per_test_timeout_ms"

run_test_command() {
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
    # shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
    source "$ROOT/scripts/ios/run_with_timeout.sh"
    local start_seconds
    local elapsed_seconds
    local status
    start_seconds="$(date +%s)"
    # run_with_timeout's 124 status is expected here when the deadline fires.
    set +e
    run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$@"
    status=$?
    set -e
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

  "$@"
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

# Both the ordinary shards and the randomized diagnostic consume this list.
discover_unit_test_files() {
  local file
  while IFS= read -r file; do
    case "$file" in
      *.integration.test.ts | test/stress/*) ;;
      *) printf '%s\n' "$file" ;;
    esac
  done < <(find test -type f -name '*.test.ts' -print | sort)
}

# Markdown backticks are literal formatting, not shell substitutions.
# shellcheck disable=SC2016
randomized_failure_summary() {
  local status="$?"
  if [[ "$status" -ne 0 && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### Randomized unit lane failed (exit %s)\n\n' "$status"
      printf 'Seed: `%s`\n\n' "$AUTOMOBILE_UNIT_RANDOM_SEED"
      printf 'Reproduce the same unit file list:\n```bash\n'
      printf 'AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_RANDOM_SEED=%s bash scripts/test-ts.sh unit\n' "$AUTOMOBILE_UNIT_RANDOM_SEED"
      printf '```\nEquivalent Bun invocation (explicit unit files):\n```bash\n'
      printf 'bun test --randomize --seed=%s <files>\n```\n' "$AUTOMOBILE_UNIT_RANDOM_SEED"
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
  trap randomized_failure_summary EXIT
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
  if [[ "$shard_mode" != unit ]]; then
    return 0
  fi
  export AUTOMOBILE_UNIT_SHARED_FILE_COUNT=0
  if [[ "$shared_total" -gt "$shard" ]]; then
    AUTOMOBILE_UNIT_SHARED_FILE_COUNT=$(((shared_total - shard + worker_count - 1) / worker_count))
  fi
  # Chunked shards split inside bun-unit-chunks.sh. An unchunked shard with
  # shared files runs both groups through bun-unit-groups.sh under the same
  # watchdog; a shard without shared files keeps the direct invocation.
  if [[ "$AUTOMOBILE_UNIT_SHARED_FILE_COUNT" -gt 0 && -z "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ]]; then
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
#                  at UNIT_CALIBRATION_TIMEOUT_SECONDS each, and the timing
#                  summary)
#   lane cap    =  AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS, by default
#                  2 * (budget + overhead) = 2 * (720 + 60) = 1560s (26 min)
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
  # shellcheck disable=SC2310 # Deliberate: a probe failure must not exit the shard.
  if ! run_with_timeout "$UNIT_CALIBRATION_TIMEOUT_SECONDS" \
    bun "$ROOT/scripts/lib/runner-calibration.ts" probe "$out" "$label"; then
    printf 'test-ts: runner calibration probe failed (%s); continuing without this sample\n' "$label" >&2
  fi
}

# Starts one shard attempt in the background and records its pid. Reads and
# sets the caller's (run_unit_shards) locals through Bash's dynamic scoping.
launch_unit_shard() {
  local shard="$1" attempt="$2" index
  shard_files=()
  shard_number="$shard"
  if [[ "$shard_mode" == "unit" ]]; then
    for ((index = shard; index < ${#test_files[@]}; index += worker_count)); do
      shard_files+=("${test_files[$index]}")
    done
    report_name="shard-${shard}.xml"
  else
    shard_number=$((shard + 1))
    shard_files=(
      --path-ignore-patterns "**/*.integration.test.ts"
      --path-ignore-patterns "test/stress/**"
      "--changed=${changed_ref}" "--shard=${shard_number}/${worker_count}"
    )
    report_name="changed-shard-${shard_number}.xml"
  fi

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
    printf '%q ' "${BUN_UNIT_TEST_COMMAND[@]}" \
      ${shard_files[@]+"${shard_files[@]}"}
    printf '\n'
    return 0
  fi

  (
    shard_started="$(date +%s)"
    timing_log="$shard_root/timing-shard-${shard}.ndjson"
    # These exports intentionally belong to the unit-shard subshell.
    # shellcheck disable=SC2030
    export AUTOMOBILE_TEST_TIMING_LOG="$timing_log"
    # shellcheck disable=SC2030
    export AUTOMOBILE_WATCHDOG_TIMING_LOG="$timing_log"
    export AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$shard_root/watchdog-shard-${shard}.txt"
    # shellcheck disable=SC2030
    export AUTOMOBILE_WATCHDOG_LABEL="${shard_mode} shard ${shard_number}"
    export AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1
    local calibration_file="${AUTOMOBILE_UNIT_JUNIT_DIR:-$shard_root}/calibration-${shard_mode}-shard-${shard}.tsv"
    local calibration_label="${shard_mode} shard ${shard_number} attempt ${attempt}"
    shard_args=("${BUN_UNIT_TEST_COMMAND[@]}")
    if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
      shard_args+=(
        --reporter junit
        --reporter-outfile "$AUTOMOBILE_UNIT_JUNIT_DIR/$report_name"
      )
    fi
    configure_unit_shard_groups "$shard"
    local shard_budget="${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}"
    if [[ "$shard_mode" == unit && -n "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ]]; then
      # One child owns the sequential loop: the watchdog bounds ALL chunks,
      # including startup/report work, and still signals their process group.
      shard_args=(bash "$ROOT/scripts/lib/bun-unit-chunks.sh" "$ROOT" "$runner_os"
        "$AUTOMOBILE_UNIT_TEST_CHUNK_FILES" "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" "$shard")
      if [[ -n "$chunk_deadline" ]]; then
        shard_budget=$((chunk_deadline - $(date +%s)))
        if [[ "$shard_budget" -le 0 ]]; then
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
      run_with_timeout "$shard_budget" \
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
  ) > "$shard_root/shard-${shard}.log" 2>&1 3>&- &
  pids[shard]=$!
}

# Succeeds when a reaped first attempt should be retried (see the arithmetic above).
unit_shard_should_retry() {
  local shard="$1" status="$2" elapsed
  if [[ "$shard_mode" != unit || "$unit_shard_retries" -eq 0 || -n "${AUTOMOBILE_UNIT_TEST_CHUNK_FILES:-}" ]]; then
    return 1
  fi
  if [[ "$status" -ne 124 ]] && ! [[ "$status" -ge 129 && "$status" -le 192 ]]; then
    return 1
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
    printf 'TIMEOUT: %s shard %d exceeded its wall-clock budget%s\n' "$shard_mode" "$number" "$suffix" >&2
    rc=124
  elif [[ "$status" -ne 0 ]]; then
    # Name every failing shard, even beside a timeout, so a real test failure
    # is never hidden behind another shard's infra exit; 124 keeps precedence.
    printf 'FAIL: %s shard %d exited with status %d%s\n' "$shard_mode" "$number" "$status" "$suffix" >&2
    if [[ "$rc" -ne 124 ]]; then
      rc=1
    fi
  elif [[ "$status" -eq 0 && -n "$suffix" ]]; then
    printf 'test-ts: %s shard %d passed on its retry\n' "$shard_mode" "$number" >&2
  fi
}

run_unit_shards() {
  local shard_mode="$1"
  local changed_ref="${2:-}"
  local shard_root="$ROOT/scratch/test-ts-${shard_mode}-shards"
  local file index shard shard_number worker_count rc shard_status report_name
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
  local retry_shards=()
  local pending_shards=()
  local still_pending=()
  local reaped_any
  local unit_shard_retries="${AUTOMOBILE_UNIT_SHARD_RETRIES:-1}"
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
  # shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
  source "$ROOT/scripts/ios/run_with_timeout.sh"

  rm -rf "$shard_root"
  mkdir -p "$shard_root"
  if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
    rm -rf "$AUTOMOBILE_UNIT_JUNIT_DIR"
    mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
  fi
  if [[ "$shard_mode" == unit ]]; then
    while IFS= read -r file; do
      shared_files+=("$file")
    done < <(shared_process_unit_files)
  fi
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

  if [[ "${#test_files[@]}" -eq 0 ]]; then
    echo "No unit test files discovered" >&2
    return 1
  fi
  if [[ "$shard_mode" == unit ]]; then
    printf 'test-ts: unit lane shared_files=%s isolated_files=%s\n' \
      "$shared_total" "${#isolated_files[@]}" >&2
  fi

  worker_count="$unit_workers"
  if [[ "$worker_count" -gt "${#test_files[@]}" ]]; then
    worker_count="${#test_files[@]}"
  fi

  if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    validate_positive_integer \
      "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
      "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
    lane_cap="${AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS:-$((2 * (AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS + UNIT_SHARD_ATTEMPT_OVERHEAD_SECONDS)))}"
    validate_positive_integer "AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS" "$lane_cap"
  fi

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" && "$shard_mode" == "unit" ]]; then
    printf \
      'bun test --isolate --no-orphans --path-ignore-patterns %q --path-ignore-patterns %q --shards=%s\n' \
      "**/*.integration.test.ts" \
      "test/stress/**" \
      "$worker_count"
    return 0
  fi

  for ((shard = 0; shard < worker_count; shard += 1)); do
    shard_attempts[shard]=1
    shard_starts[shard]="$(date +%s)"
    launch_unit_shard "$shard" 1
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
  for ((shard = 0; shard < worker_count; shard += 1)); do
    pending_shards+=("$shard")
  done
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
      # shellcheck disable=SC2310 # A predicate: a false result is expected control flow.
      if [[ "${shard_attempts[$index]}" -eq 1 ]] && unit_shard_should_retry "$index" "$shard_status"; then
        retry_unit_shard "$index" "$shard_status"
        retry_shards+=("$index")
        still_pending+=("$index")
        continue
      fi
      finish_unit_shard "$index" "$shard_status"
    done
    pending_shards=(${still_pending[@]+"${still_pending[@]}"})
    if [[ "$reaped_any" -eq 0 && "${#pending_shards[@]}" -gt 0 ]]; then
      sleep "$reap_poll_seconds"
    fi
  done

  if [[ "$shard_mode" == "unit" ]]; then
    lane_elapsed=$(($(date +%s) - lane_start))
    for ((shard = 0; shard < worker_count; shard += 1)); do
      attempts_note=""
      if [[ "${shard_attempts[$shard]}" -gt 1 ]]; then
        attempts_note=" attempts=${shard_attempts[$shard]}"
      fi
      printf 'test-ts: unit shard %d/%d wall=%ss status=%s%s\n' \
        "$((shard + 1))" "$worker_count" \
        "${shard_elapsed_seconds[$shard]}" "${shard_statuses[$shard]}" "$attempts_note" >&2
    done
    printf 'test-ts: unit shards total wall=%ss status=%s retried=%s\n' \
      "$lane_elapsed" "$rc" "${#retry_shards[@]}" >&2
  fi

  for ((shard = 0; shard < worker_count; shard += 1)); do
    if [[ -f "$shard_root/shard-${shard}.attempt-1.log" ]]; then
      printf '\n==> TypeScript %s shard %d/%d (attempt 1 of 2, retried)\n' "$shard_mode" "$((shard + 1))" "$worker_count"
      command cat "$shard_root/shard-${shard}.attempt-1.log"
    fi
    printf '\n==> TypeScript %s shard %d/%d\n' "$shard_mode" "$((shard + 1))" "$worker_count"
    command cat "$shard_root/shard-${shard}.log"
  done
  return "$rc"
}

parallel_workers="$unit_workers"
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
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "${#passthrough_args[@]}" -eq 0 && "$runner_os" != "Windows" ]]; then
      run_unit_shards unit
    else
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
      mkdir -p scratch
      # These assignments run in the parent shell, independent of unit shards.
      # shellcheck disable=SC2031
      export AUTOMOBILE_TEST_TIMING_LOG="${AUTOMOBILE_TEST_TIMING_LOG:-scratch/integration-file-timings-$$.ndjson}"
      # shellcheck disable=SC2031
      export AUTOMOBILE_WATCHDOG_TIMING_LOG="${AUTOMOBILE_WATCHDOG_TIMING_LOG:-$AUTOMOBILE_TEST_TIMING_LOG}"
      # shellcheck disable=SC2031
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
      if [[ "$runner_os" == "Windows" || "$coverage_requested" == true || "$long_lived" == true ]]; then
        # The Windows lane already passes as one process, and its shell does not
        # use the POSIX watchdog needed for the stalled Unix transport suite.
        # Coverage also stays in one process so Bun writes a complete LCOV
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
          trap 'rm -rf "$report_dir"' EXIT
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
        # shellcheck disable=SC2310
        if AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$transport_suite_timeout" run_test_command \
          "${integration_args[@]}" \
          test/server/proxyServerTransportFailure.integration.test.ts \
          "${transport_args[@]+"${transport_args[@]}"}"; then
          :
        else
          transport_status=$?
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
            done < <(find test -type f -name '*.integration.test.ts' | LC_ALL=C sort)
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
            # shellcheck disable=SC2310
            if AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$file_timeout" run_test_command \
              "${integration_args[@]}" "$integration_file" "${file_args[@]+"${file_args[@]}"}"; then
              :
            else
              file_status=$?
            fi
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
          # shellcheck disable=SC2310
          if AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$integration_remaining" run_test_command \
            "${integration_args[@]}" \
            "${main_targets[@]}" \
            "${main_args[@]+"${main_args[@]}"}"; then
            :
          else
            main_status=$?
          fi
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
      rm -rf coverage
      mkdir -p coverage/shards
    fi
    coverage_pids=()
    for ((coverage_shard = 1; coverage_shard <= coverage_shards; coverage_shard += 1)); do
      # Round-robin over the sorted list: every file runs in exactly one shard
      # and each shard sees a similar mix of directories.
      shard_files=()
      for ((index = coverage_shard - 1; index < ${#coverage_files[@]}; index += coverage_shards)); do
        shard_files+=("${coverage_files[$index]}")
      done
      coverage_chunks=(
        bash "$ROOT/scripts/lib/bun-unit-chunks.sh" "$ROOT" "$runner_os"
        "$coverage_chunk_files" "" "$coverage_shard"
        ${coverage_prefix[@]+"${coverage_prefix[@]}"} -- ${shard_files[@]+"${shard_files[@]}"}
      )
      if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
        printf '%q ' "${coverage_chunks[@]}"
        printf '\n'
        continue
      fi
      (
        export AUTOMOBILE_CHUNK_COVERAGE_ROOT="coverage/shards"
        if [[ "$runner_os" != "Windows" ]]; then
          export AUTOMOBILE_TEST_TIMING_LOG="coverage/shards/timing-shard-${coverage_shard}.ndjson"
          export AUTOMOBILE_WATCHDOG_TIMING_LOG="$AUTOMOBILE_TEST_TIMING_LOG"
          export AUTOMOBILE_WATCHDOG_LABEL="coverage shard ${coverage_shard}/${coverage_shards}"
        fi
        if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
          # shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
          source "$ROOT/scripts/ios/run_with_timeout.sh"
          run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "${coverage_chunks[@]}"
        else
          "${coverage_chunks[@]}"
        fi
      ) > "coverage/shards/shard-${coverage_shard}.log" 2>&1 3>&- &
      coverage_pids+=("$!")
    done
    if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
      exit 0
    fi
    coverage_status=0
    for ((coverage_index = 0; coverage_index < ${#coverage_pids[@]}; coverage_index += 1)); do
      shard_status=0
      wait "${coverage_pids[$coverage_index]}" || shard_status=$?
      if [[ "$shard_status" -eq 124 ]]; then
        echo "Coverage test run exceeded its ${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS}s wall-clock budget (shard $((coverage_index + 1))/${coverage_shards})." >&2
        coverage_status=124
      elif [[ "$shard_status" -ne 0 ]]; then
        echo "FAIL: coverage shard $((coverage_index + 1))/${coverage_shards} exited with status ${shard_status}" >&2
        if [[ "$coverage_status" -ne 124 ]]; then coverage_status=1; fi
      fi
    done
    for ((coverage_shard = 1; coverage_shard <= coverage_shards; coverage_shard += 1)); do
      printf '\n==> TypeScript coverage shard %d/%d\n' "$coverage_shard" "$coverage_shards"
      command cat "coverage/shards/shard-${coverage_shard}.log"
    done
    if [[ "$coverage_status" -ne 0 ]]; then exit "$coverage_status"; fi
    coverage_lcov_files=()
    coverage_junit_files=()
    for ((coverage_shard = 1; coverage_shard <= coverage_shards; coverage_shard += 1)); do
      coverage_manifest="coverage/shards/shard-${coverage_shard}.chunks"
      if [[ ! -f "$coverage_manifest" ]]; then
        echo "FAIL: coverage shard ${coverage_shard}/${coverage_shards} wrote no chunk manifest" >&2
        exit 1
      fi
      coverage_chunk_total="$(< "$coverage_manifest")"
      for ((coverage_chunk = 1; coverage_chunk <= coverage_chunk_total; coverage_chunk += 1)); do
        coverage_dir="coverage/shards/shard-${coverage_shard}-chunk-${coverage_chunk}"
        bash scripts/ci/verify-ts-coverage-output.sh "$coverage_dir"
        coverage_lcov_files+=("${coverage_dir}/lcov.info")
        coverage_junit_files+=("${coverage_dir}.xml")
      done
    done
    if [[ "${#coverage_lcov_files[@]}" -eq 1 ]]; then
      cp "${coverage_lcov_files[0]}" coverage/lcov.info
      cp "${coverage_junit_files[0]}" coverage/junit.xml
    else
      bun scripts/lib/merge-lcov.ts coverage/lcov.info "${coverage_lcov_files[@]+"${coverage_lcov_files[@]}"}"
      bun scripts/lib/merge-junit-reports.ts coverage/junit.xml "${coverage_junit_files[@]+"${coverage_junit_files[@]}"}"
    fi
    ;;
  all)
    if [[ "$has_test_targets" -eq 0 || "${#unit_test_paths[@]}" -gt 0 ]]; then
      "$0" unit "${unit_test_paths[@]+"${unit_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    if [[ "$has_test_targets" -eq 0 || "${#integration_test_paths[@]}" -gt 0 ]]; then
      "$0" integration "${integration_test_paths[@]+"${integration_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    if [[ "$has_test_targets" -eq 0 || "${#stress_test_paths[@]}" -gt 0 ]]; then
      "$0" stress "${stress_test_paths[@]+"${stress_test_paths[@]}"}" "${passthrough_args[@]+"${passthrough_args[@]}"}"
    fi
    ;;
  *)
    echo "Usage: scripts/test-ts.sh {unit|changed|integration|stress|coverage|all} [bun-test-args...]" >&2
    exit 2
    ;;
esac
