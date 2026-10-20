#!/usr/bin/env bash
# Run one Go-based checker (`tsgo`, `tsgolint` through `oxlint --type-aware`) under the host
# test-slot pool (scripts/lib/host-slots.sh), so concurrent lanes cannot saturate the machine
# with checkers that otherwise start one worker per core (#13910).
#
#   source scripts/lib/host-heavy-run.sh
#   host_heavy_run <command> [args...]
#
# The run asks for AUTOMOBILE_HEAVY_CHECK_SLOTS slots (default 4) from the same pool unit-test
# workers use. A lone run gets them all and keeps the tool's default parallelism. When fewer were
# free, the checker's threads are capped to the slots acquired (GOMAXPROCS, which Go checkers
# honour), and with none free the run waits up to AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS (default
# 300) before proceeding with one thread, so a stuck pool can never deadlock a gate.
# AUTOMOBILE_HOST_TEST_SLOTS=off disables the cap, as for test-ts.sh.

host_heavy_cores() {
  local cores
  cores="$(nproc 2> /dev/null || sysctl -n hw.ncpu 2> /dev/null || getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)"
  if ! [[ "$cores" =~ ^[1-9][0-9]*$ ]]; then cores=4; fi
  printf '%s\n' "$cores"
}

host_heavy_run() {
  local root demand wait_seconds
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  demand="${AUTOMOBILE_HEAVY_CHECK_SLOTS:-4}"
  wait_seconds="${AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS:-300}"
  if ! [[ "$demand" =~ ^[1-9][0-9]{0,2}$ ]]; then
    echo "AUTOMOBILE_HEAVY_CHECK_SLOTS must be a positive integer, got: $demand" >&2
    return 2
  fi
  if ! [[ "$wait_seconds" =~ ^[0-9]{1,5}$ ]]; then
    echo "AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS must be a non-negative integer, got: $wait_seconds" >&2
    return 2
  fi
  # A subshell keeps the slot bookkeeping and traps out of the calling script.
  (
    # shellcheck source=scripts/lib/host-slots.sh
    source "$root/scripts/lib/host-slots.sh"
    trap host_slots_release EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap 'exit 129' HUP
    cores="$(host_heavy_cores)"
    waited=0
    while true; do
      host_slots_acquire "$demand" "$cores" || exit $?
      if [[ "$host_slots_acquired" -gt 0 || "$waited" -ge "$wait_seconds" ]]; then break; fi
      sleep 2
      waited=$((waited + 2))
    done
    if [[ "$host_slots_acquired" -lt "$demand" ]]; then
      threads="$host_slots_acquired"
      if [[ "$threads" -lt 1 ]]; then threads=1; fi
      printf 'host-heavy-run: %s of %s slots free after %ss; capping checker threads to %s\n' \
        "$host_slots_acquired" "$demand" "$waited" "$threads" >&2
      export GOMAXPROCS="$threads"
    fi
    "$@"
  )
}
