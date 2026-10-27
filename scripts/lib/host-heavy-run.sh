#!/usr/bin/env bash
# Run one Go-based checker (`tsgo`, `tsgolint` through `oxlint --type-aware`) under the host
# test-slot pool (scripts/lib/host-slots.sh), so concurrent lanes cannot saturate the machine
# with checkers that otherwise start one worker per core (#13910).
#
#   source scripts/lib/host-heavy-run.sh
#   host_heavy_run <command> [args...]
#
# The run asks for AUTOMOBILE_HEAVY_CHECK_SLOTS slots (default 4) from the same pool unit-test
# workers use. Unless it holds the entire base pool with no other run holding slots, the checker is
# capped to the slots it holds: GOMAXPROCS for the Go checkers, plus the thread cap as the command's
# last argument (empty when uncapped) for tools with their own thread flag (`tsgo --checkers`,
# `oxlint --threads`). A run holding only part of a larger pool is capped even when alone, because a
# later run can take the rest while it is still going (#14450). A run with the whole pool to itself
# keeps the tool's default parallelism. With no slot free the run waits up to
# AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS (default 60) and then proceeds with one thread, so a full
# pool can never deadlock a gate. AUTOMOBILE_HOST_TEST_SLOTS=off disables the cap.

host_heavy_cores() {
  local cores
  cores="$(nproc 2> /dev/null || sysctl -n hw.ncpu 2> /dev/null || getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)"
  if ! [[ "$cores" =~ ^[1-9][0-9]*$ ]]; then cores=4; fi
  printf '%s\n' "$cores"
}

# Whether another live process holds a slot in the pool (this process's own slots do not count).
host_heavy_pool_shared() {
  local coordination path owner
  coordination="${AUTOMOBILE_COORDINATION_DIR:-${AUTO_MOBILE_COORDINATION_DIR:-${HOME}/.auto-mobile}}"
  for path in "$coordination"/test-slots/*; do
    [[ -r "$path/owner.pid" ]] || continue
    owner=""
    read -r owner < "$path/owner.pid" || true
    if [[ "$owner" =~ ^[1-9][0-9]*$ && "$owner" != "$host_slots_owner" ]] && kill -0 "$owner" 2> /dev/null; then
      return 0
    fi
  done
  return 1
}

host_heavy_run() {
  local root demand wait_seconds
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  demand="${AUTOMOBILE_HEAVY_CHECK_SLOTS:-4}"
  wait_seconds="${AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS:-60}"
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
    # The slots belong to this subshell, not to the script that started it: if that script is
    # killed while the checker runs on, the slots must stay booked until the checker is done.
    host_slots_owner="$(exec sh -c 'echo "$PPID"')"
    trap host_slots_release EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap 'exit 129' HUP
    cores="$(host_heavy_cores)"
    waited=0
    while true; do
      acquire_status=0
      host_slots_acquire "$demand" "$cores" || acquire_status=$?
      if [[ "$acquire_status" -ne 0 ]]; then exit "$acquire_status"; fi
      if [[ "$host_slots_acquired" -gt 0 || "$waited" -ge "$wait_seconds" ]]; then break; fi
      if [[ "$waited" -eq 0 ]]; then
        echo "host-heavy-run: waiting up to ${wait_seconds}s for a free host slot" >&2
      fi
      sleep 2
      waited=$((waited + 2))
    done
    threads=""
    if [[ "${AUTOMOBILE_HOST_TEST_SLOTS:-}" != off ]] &&
      { [[ "$host_slots_acquired" -lt "$demand" ]] ||
        [[ "$host_slots_acquired" -lt "${host_slots_capacity:-0}" ]] ||
        host_heavy_pool_shared; }; then
      threads="$host_slots_acquired"
      if [[ "$threads" -lt 1 ]]; then threads=1; fi
      printf 'host-heavy-run: holding %s of %s slots (waited %ss); capping checker threads to %s\n' \
        "$host_slots_acquired" "$demand" "$waited" "$threads" >&2
      export GOMAXPROCS="$threads"
    fi
    "$@" "$threads"
  )
}

# The checkers themselves, run through host_heavy_run (the cap is their last argument). A capped
# run also bounds tsgo's checker count (so its memory, not just its CPU) and oxlint's own threads.
host_heavy_tsgo() {
  local tsconfig="$1" threads="$2"
  bunx tsgo --noEmit -p "$tsconfig" ${threads:+--checkers "$threads"}
}

# Only the linter's own stderr is dropped, so the helper's messages stay visible.
host_heavy_oxlint_type_aware() {
  local threads="$1"
  bunx oxlint --type-aware --format json ${threads:+--threads "$threads"} 2> /dev/null
}

# The fast oxlint stage of scripts/lint.sh (Rust, one thread per core by default). The cap is the
# last argument; every other argument is oxlint's own.
host_heavy_oxlint() {
  local threads="${*: -1}"
  local -a args=("${@:1:$#-1}")
  oxlint ${threads:+--threads "$threads"} ${args[@]+"${args[@]}"}
}
