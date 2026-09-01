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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
    if [[ "$#" -eq 0 && "$runner_os" != "Windows" ]]; then
      run_unit_shards
    else
      run_test_command "${unit_args[@]}" "$@"
    fi
    ;;
  changed)
    changed_ref="${AUTOMOBILE_UNIT_TEST_BASE_REF:-origin/main}"
    run_test_command "${unit_args[@]}" "--changed=${changed_ref}" "$@"
    ;;
  integration)
    integration_args=(bun test --timeout "$per_test_timeout_ms")
    if [[ "$runner_os" != "Windows" ]]; then
      integration_args+=(--no-orphans "--parallel=${integration_workers}")
    fi
    run_test_command "${integration_args[@]}" ".integration.test.ts" "$@"
    ;;
  stress)
    run_test_command bun test --timeout "$per_test_timeout_ms" test/stress "$@"
    ;;
  coverage)
    run_test_command \
      "${unit_args[@]}" \
      --coverage \
      --coverage-reporter=lcov \
      --coverage-dir=coverage \
      "$@"
    ;;
  all)
    "$0" unit "$@"
    "$0" integration "$@"
    "$0" stress "$@"
    ;;
  *)
    echo "Usage: scripts/test-ts.sh {unit|changed|integration|stress|coverage|all} [bun-test-args...]" >&2
    exit 2
    ;;
esac
