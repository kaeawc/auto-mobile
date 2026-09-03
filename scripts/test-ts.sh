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

cores="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
if ! [[ "$cores" =~ ^[0-9]+$ ]] || [[ "$cores" -lt 1 ]]; then
  cores=4
fi

default_workers=$((cores - 2))
if [[ "$default_workers" -lt 1 ]]; then
  default_workers=1
fi

unit_workers="${AUTOMOBILE_UNIT_TEST_WORKERS:-$default_workers}"
integration_workers="${AUTOMOBILE_INTEGRATION_TEST_WORKERS:-1}"
per_test_timeout_ms="${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}"
runner_os="${RUNNER_OS:-}"
if [[ -z "$runner_os" ]]; then
  case "$(uname -s 2> /dev/null || true)" in
    Darwin) runner_os="macOS" ;;
    MINGW* | MSYS* | CYGWIN*) runner_os="Windows" ;;
  esac
fi
if [[ "$runner_os" == "macOS" ]]; then
  per_test_timeout_ms="${AUTOMOBILE_TEST_TIMEOUT_MS:-20000}"
fi
if [[ -z "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-}" && "$runner_os" != "Windows" ]]; then
  case "$mode" in
    unit | changed) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=180 ;;
    integration) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=900 ;;
    stress | coverage) export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=300 ;;
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
    run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" "$@"
    return
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
  local file index shard worker_count rc pid
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
      shard_args=(bun test --isolate --timeout "$per_test_timeout_ms" --no-orphans)
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
        run_with_timeout "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" \
          ${shard_args[@]+"${shard_args[@]}"} \
          ${shard_files[@]+"${shard_files[@]}"}
      else
        ${shard_args[@]+"${shard_args[@]}"} \
          ${shard_files[@]+"${shard_files[@]}"}
      fi
    ) > "$shard_root/shard-${shard}.log" 2>&1 &
    pids+=("$!")
  done

  rc=0
  for ((index = 0; index < ${#pids[@]}; index += 1)); do
    pid="${pids[$index]}"
    if ! wait "$pid"; then
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
    integration_args=(bun test --timeout "$per_test_timeout_ms")
    if [[ "$runner_os" != "Windows" ]]; then
      integration_args+=(--no-orphans "--parallel=${integration_workers}")
    fi
    if [[ "${#integration_test_paths[@]}" -gt 0 && ( "${#unit_test_paths[@]}" -gt 0 || "${#stress_test_paths[@]}" -gt 0 ) ]]; then
      echo "Integration test targets cannot include other lanes." >&2
      exit 2
    elif [[ "${#integration_test_paths[@]}" -gt 0 ]]; then
      run_test_command \
        "${integration_args[@]}" \
        "${integration_test_paths[@]+"${integration_test_paths[@]}"}" \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
    elif [[ "$has_test_targets" -eq 0 ]]; then
      run_test_command \
        "${integration_args[@]}" \
        ".integration.test.ts" \
        "${passthrough_args[@]+"${passthrough_args[@]}"}"
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
