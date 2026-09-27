#!/usr/bin/env bash
#
# Canonical Bun test-lane runner.
#
#   unit        Hermetic *.test.ts tests, excluding integration and stress.
#   changed     Unit tests affected by worktree/ref changes (local feedback).
#   integration Real-I/O *.integration.test.ts tests.
#   stress      Explicit test/stress/** tests.
#   coverage    Complete unit lane with LCOV coverage.
#   all         Unit, host integration, then stress.
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

default_workers=$((cores - 2))
if [[ "$default_workers" -lt 1 ]]; then
  default_workers=1
fi
if [[ "$runner_os" == "macOS" && "$cores" -ge 2 && "$default_workers" -lt 2 ]]; then
  default_workers=2
fi

unit_workers="${AUTOMOBILE_UNIT_TEST_WORKERS:-$default_workers}"
integration_workers="${AUTOMOBILE_INTEGRATION_TEST_WORKERS:-1}"
per_test_timeout_ms="${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}"
if [[ "$runner_os" == "macOS" ]]; then
  per_test_timeout_ms="${AUTOMOBILE_TEST_TIMEOUT_MS:-20000}"
fi
if [[ -z "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" && "$runner_os" != "Windows" ]]; then
  case "$mode" in
    unit | changed) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=180 ;;
    integration) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=900 ;;
    stress) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=300 ;;
    coverage) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=480 ;;
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
validate_positive_integer "AUTOMOBILE_INTEGRATION_TEST_WORKERS" "$integration_workers"
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

run_unit_shards() {
  local shard_root="$ROOT/scratch/test-ts-unit-shards"
  local file index shard worker_count rc pid shard_status timing_log
  local test_files=()
  local pids=()

  rm -rf "$shard_root"
  mkdir -p "$shard_root"
  if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
    rm -rf "$AUTOMOBILE_UNIT_JUNIT_DIR"
    mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
  fi
  while IFS= read -r file; do
    case "$file" in
      *.integration.test.ts | test/stress/*) ;;
      *) test_files+=("$file") ;;
    esac
  done < <(find test -type f -name '*.test.ts' -print | sort)

  if [[ "${#test_files[@]}" -eq 0 ]]; then
    echo "No unit test files discovered" >&2
    return 1
  fi

  worker_count="$unit_workers"
  if [[ "$worker_count" -gt "${#test_files[@]}" ]]; then
    worker_count="${#test_files[@]}"
  fi

  if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
    validate_positive_integer \
      "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
      "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
  fi

  if [[ "${TEST_TS_PRINT_CMD:-}" == "1" ]]; then
    printf \
      'bun test --isolate --no-orphans --path-ignore-patterns %q --path-ignore-patterns %q --shards=%s\n' \
      "**/*.integration.test.ts" \
      "test/stress/**" \
      "$worker_count"
    return 0
  fi

  for ((shard = 0; shard < worker_count; shard += 1)); do
    local shard_files=()
    for ((index = shard; index < ${#test_files[@]}; index += worker_count)); do
      shard_files+=("${test_files[$index]}")
    done

    (
      timing_log="$shard_root/timing-shard-${shard}.ndjson"
      export AUTOMOBILE_TEST_TIMING_LOG="$timing_log"
      export AUTOMOBILE_WATCHDOG_TIMING_LOG="$timing_log"
      export AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$shard_root/watchdog-shard-${shard}.txt"
      export AUTOMOBILE_WATCHDOG_LABEL="unit shard ${shard}"
      export AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1
      shard_args=(bun test --isolate --timeout "$per_test_timeout_ms" --no-orphans \
        --preload "$ROOT/test/setup/fileTimingProbe.ts")
      if [[ -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" ]]; then
        shard_args+=(
          --reporter junit
          --reporter-outfile "$AUTOMOBILE_UNIT_JUNIT_DIR/shard-${shard}.xml"
        )
      fi
      if [[ -n "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" ]]; then
        validate_positive_integer \
          "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
          "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS"
        # shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
        source "$ROOT/scripts/ios/run_with_timeout.sh"
        shard_status=0
        set +e
        run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
          ${shard_args[@]+"${shard_args[@]}"} \
          ${shard_files[@]+"${shard_files[@]}"}
        shard_status=$?
        set -e
      else
        shard_status=0
        ${shard_args[@]+"${shard_args[@]}"} \
          ${shard_files[@]+"${shard_files[@]}"} || shard_status=$?
      fi
      if [[ -s "$timing_log" ]]; then
        bun "$ROOT/scripts/lib/test-file-timings.ts" summary "$timing_log" || true
      fi
      exit "$shard_status"
    ) > "$shard_root/shard-${shard}.log" 2>&1 &
    pids+=("$!")
  done

  rc=0
  for ((index = 0; index < ${#pids[@]}; index += 1)); do
    pid="${pids[$index]}"
    shard_status=0
    wait "$pid" || shard_status=$?
    if [[ "$shard_status" -eq 124 ]]; then
      printf 'TIMEOUT: unit shard %d exceeded its wall-clock budget\n' "$index" >&2
      rc=124
    elif [[ "$shard_status" -ne 0 && "$rc" -ne 124 ]]; then
      rc=1
    fi
  done

  for ((shard = 0; shard < worker_count; shard += 1)); do
    printf '\n==> TypeScript unit shard %d/%d\n' "$((shard + 1))" "$worker_count"
    command cat "$shard_root/shard-${shard}.log"
  done
  return "$rc"
}

parallel_workers="$unit_workers"
if [[ "$mode" == "coverage" ]]; then
  # Bun's coverage reporter and Linux epoll-backed streams are not reliable
  # when the full unit suite is executed in parallel. Keep coverage deterministic
  # while the normal unit lane retains its parallel speed.
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
    if [[ "${#unit_test_paths[@]}" -gt 0 && ( "${#integration_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Unit test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "$has_test_targets" -eq 1 ]]; then
      echo "No unit test paths were selected." >&2
      exit 2
    elif [[ "${#unit_test_paths[@]}" -eq 0 && "${#passthrough_args[@]}" -eq 0 && "$runner_os" != "Windows" ]]; then
      run_unit_shards
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
      integration_args+=(--no-orphans "--parallel=${integration_workers}")
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
        # shellcheck disable=SC2310
        if AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS="$integration_remaining" run_test_command \
          "${integration_args[@]}" \
          "${main_targets[@]}" \
          "${main_args[@]+"${main_args[@]}"}"; then
          :
        else
          main_status=$?
        fi
        if [[ -n "$report_outfile" && "${TEST_TS_PRINT_CMD:-}" != 1 ]]; then
          if [[ -f "$report_dir/transport.xml" && -f "$report_dir/main.xml" ]]; then
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
    run_test_command \
      "${unit_args[@]}" \
      --coverage \
      --coverage-reporter=lcov \
      --coverage-dir=coverage \
      "${unit_test_paths[@]+"${unit_test_paths[@]}"}" \
      "${passthrough_args[@]+"${passthrough_args[@]}"}"
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
