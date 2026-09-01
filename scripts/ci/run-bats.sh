#!/usr/bin/env bash
#
# Runs BATS files as independent processes with cross-file parallelism.
#
# The suite is ~900 tests across ~125 files and, run serially, dominated the
# CI wall-clock (~3.5min on the required "Shell Tests" gate). Most files isolate
# their state in `mktemp -d` temp dirs (temp git repos, temp roots passed to
# scripts via root-override args), so they are independent and can run
# concurrently.
#
# Each lane uses two passes:
#
#   1. Parallel pass — every selected file except files tagged `serial`. Each
#      GNU Parallel job runs exactly one `bats <file>` process, so BATS never
#      aggregates discovery/counting across the complete suite.
#
#   2. Serial pass — selected files tagged `serial`. Two hazard classes carry the tag:
#      (a) files that write a fixture into the REAL source tree and scan it, so
#      they race each other (and any tree scan) under parallelism; and (b) files
#      that spawn real processes and assert timing-bounded reaping, which flakes
#      under CPU oversubscription. They run one file at a time here, after the
#      parallel pass, so no fixture is present while an unrelated file scans, and
#      the process tests get an uncontended CPU. A guard test
#      (test/scripts/batsSerialTags.test.ts) fails if a new real-tree mutator
#      lands without the tag.
#
# The orthogonal `integration` file tag selects real network/process/timing or
# host-tool tests. The default `unit` lane excludes those files.
#
# The functions are defined unconditionally but main() only runs when the script
# is executed, not sourced, so test/bats/run-bats.bats can source it and probe
# individual functions (e.g. is_gnu_parallel) without triggering an install.

log() { printf '%s\n' "$*" >&2; }

# `bats --jobs` requires *GNU* parallel specifically. A bare `command -v
# parallel` is not enough: the unrelated moreutils `parallel` is also named
# `parallel` and would satisfy it while breaking bats. Only GNU parallel prints
# a "GNU parallel" banner from `--version`, so probe that capability.
is_gnu_parallel() {
  parallel --version 2> /dev/null | head -1 | grep -q "GNU parallel"
}

ensure_gnu_parallel() {
  if is_gnu_parallel; then
    return 0
  fi
  log "GNU parallel not found (or a non-GNU 'parallel' is on PATH); installing"
  if command -v brew > /dev/null 2>&1; then
    brew install parallel
  elif command -v apt-get > /dev/null 2>&1; then
    sudo apt-get update -qq
    # The Debian/Ubuntu 'parallel' package IS GNU parallel.
    sudo apt-get install -y -qq parallel
  else
    log "ERROR: cannot install GNU parallel (no brew or apt-get)"
    return 1
  fi
  if ! is_gnu_parallel; then
    log "ERROR: GNU parallel still not available after install (a non-GNU 'parallel' may be shadowing it on PATH)"
    return 1
  fi
}

# GNU parallel prints a citation banner to stderr on every invocation until the
# user acknowledges it. Drop the marker so the suite's output stays readable.
silence_parallel_citation() {
  local home_dir="${PARALLEL_HOME:-$HOME/.parallel}"
  mkdir -p "$home_dir"
  touch "$home_dir/will-cite"
}

# _NPROCESSORS_ONLN is portable across the Linux and macOS runners; fall back to
# 2 if the host does not expose it.
job_count() {
  local jobs
  jobs="$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 2)"
  if ! [[ "$jobs" =~ ^[0-9]+$ ]] || [[ "$jobs" -lt 1 ]]; then
    jobs=2
  fi
  printf '%s\n' "$jobs"
}

has_file_tag() {
  local bats_file="$1"
  local expected="$2"
  awk -v expected="$expected" '
    /^#[[:space:]]*bats[[:space:]]+file_tags=/ {
      tags = $0
      sub(/^#[[:space:]]*bats[[:space:]]+file_tags=/, "", tags)
      count = split(tags, values, ",")
      for (i = 1; i <= count; i += 1) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", values[i])
        if (values[i] == expected) {
          found = 1
        }
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$bats_file"
}

classify_files() {
  local bats_dir="$1"
  local lane="$2"
  local parallel_list="$3"
  local serial_list="$4"
  local bats_file is_integration

  while IFS= read -r -d '' bats_file; do
    is_integration=false
    if has_file_tag "$bats_file" integration; then
      is_integration=true
    fi

    if [[ "$lane" == "unit" && "$is_integration" == "true" ]]; then
      continue
    fi
    if [[ "$lane" == "integration" && "$is_integration" == "false" ]]; then
      continue
    fi

    if has_file_tag "$bats_file" serial; then
      printf '%s\0' "$bats_file" >> "$serial_list"
    else
      printf '%s\0' "$bats_file" >> "$parallel_list"
    fi
  done < <(find "$bats_dir" -type f -name '*.bats' -print0)
}

run_parallel_files() {
  local list_file="$1"
  local jobs="$2"
  local joblog="$3"
  if [[ ! -s "$list_file" ]]; then
    return 0
  fi

  parallel \
    --jobs "$jobs" \
    --keep-order \
    --halt never \
    --joblog "$joblog" \
    -0 \
    bats {} < "$list_file"
}

run_serial_files() {
  local list_file="$1"
  local max_seconds="${2:-}"
  local bats_file rc=0 started elapsed
  if [[ ! -s "$list_file" ]]; then
    return 0
  fi

  while IFS= read -r -d '' bats_file; do
    started="$SECONDS"
    bats "$bats_file" || rc=1
    elapsed=$((SECONDS - started))
    log "BATS file duration: ${elapsed}s ${bats_file}"
    if [[ -n "$max_seconds" && "$elapsed" -gt "$max_seconds" ]]; then
      log "ERROR: ${bats_file} took ${elapsed}s, exceeding the ${max_seconds}s unit-file budget; tag genuine real-I/O coverage as integration"
      rc=1
    fi
  done < "$list_file"
  return "$rc"
}

enforce_parallel_file_budget() {
  local joblog="$1"
  local max_seconds="$2"
  if [[ ! -s "$joblog" ]]; then
    return 0
  fi

  awk -v limit="$max_seconds" '
    NR > 1 && $4 > limit {
      printf "ERROR: %s took %.2fs, exceeding the %ss unit-file budget; tag genuine real-I/O coverage as integration\n", $10, $4, limit > "/dev/stderr"
      failed = 1
    }
    END { exit(failed ? 1 : 0) }
  ' "$joblog"
}

enforce_unit_budget() {
  local elapsed="$1"
  local budget="${AUTOMOBILE_BATS_UNIT_BUDGET_SECONDS:-}"
  if [[ -z "$budget" ]]; then
    return 0
  fi
  if ! [[ "$budget" =~ ^[1-9][0-9]*$ ]]; then
    log "ERROR: AUTOMOBILE_BATS_UNIT_BUDGET_SECONDS must be a positive integer"
    return 2
  fi
  if [[ "$elapsed" -gt "$budget" ]]; then
    log "ERROR: BATS unit lane took ${elapsed}s, exceeding ${budget}s"
    return 1
  fi
}

main() {
  # errexit is deliberately NOT set: this script branches on the exit status of
  # helper functions (ensure_gnu_parallel, is_gnu_parallel) and of each bats
  # pass, which under `set -e` both trips SC2310 (set -e is suppressed inside a
  # function invoked in a condition) and would abort before the serial pass.
  # Errors are handled explicitly instead, and rc aggregates both passes.
  set -uo pipefail
  local lane="${1:-unit}"
  if [[ "$lane" != "unit" && "$lane" != "integration" && "$lane" != "all" ]]; then
    log "Usage: scripts/ci/run-bats.sh {unit|integration|all} [bats-directory]"
    return 2
  fi
  shift || true
  local bats_dir="${1:-test/bats}"

  ensure_gnu_parallel || exit 1
  silence_parallel_citation

  if [[ "$lane" == "all" ]]; then
    local all_rc=0
    main unit "$bats_dir" || all_rc=1
    main integration "$bats_dir" || all_rc=1
    return "$all_rc"
  fi

  local jobs="${AUTOMOBILE_BATS_JOBS:-$(job_count)}"
  if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
    log "ERROR: AUTOMOBILE_BATS_JOBS must be a positive integer"
    return 2
  fi

  local temp_dir parallel_list serial_list joblog
  temp_dir="$(mktemp -d)"
  parallel_list="$temp_dir/parallel-files"
  serial_list="$temp_dir/serial-files"
  joblog="${AUTOMOBILE_BATS_JOBLOG:-scratch/bats-${lane}-joblog.tsv}"
  : > "$parallel_list"
  : > "$serial_list"
  mkdir -p "$(dirname "$joblog")"
  rm -f "$joblog"
  classify_files "$bats_dir" "$lane" "$parallel_list" "$serial_list"
  if [[ ! -s "$parallel_list" && ! -s "$serial_list" ]]; then
    log "ERROR: no BATS files selected for ${lane} lane in ${bats_dir}"
    rm -rf "$temp_dir"
    return 1
  fi

  local file_budget=""
  if [[ "$lane" == "unit" ]]; then
    file_budget="${AUTOMOBILE_BATS_MAX_FILE_SECONDS:-}"
    if [[ -n "$file_budget" ]] && ! [[ "$file_budget" =~ ^[1-9][0-9]*$ ]]; then
      log "ERROR: AUTOMOBILE_BATS_MAX_FILE_SECONDS must be a positive integer"
      rm -rf "$temp_dir"
      return 2
    fi
  fi

  local started="$SECONDS"
  local rc=0
  log "Parallel ${lane} pass: one BATS file per GNU Parallel job (${jobs} jobs)"
  run_parallel_files "$parallel_list" "$jobs" "$joblog" || rc=1

  log "Serial ${lane} pass: files tagged serial"
  run_serial_files "$serial_list" "$file_budget" || rc=1

  local elapsed=$((SECONDS - started))
  log "BATS ${lane} lane completed in ${elapsed}s (job log: ${joblog})"
  if [[ "$lane" == "unit" ]]; then
    if [[ -n "$file_budget" ]]; then
      enforce_parallel_file_budget "$joblog" "$file_budget" || rc=1
    fi
    enforce_unit_budget "$elapsed" || rc=1
  fi

  rm -rf "$temp_dir"
  return "$rc"
}

# Only run when executed directly; sourcing (from tests) just loads the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
