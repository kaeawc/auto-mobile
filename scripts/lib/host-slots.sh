#!/usr/bin/env bash
# Non-blocking host test-worker semaphore. Source in the lane's owning shell;
# the caller composes host_slots_release into its EXIT/signal cleanup.
# No flock dependency: mkdir is atomic on both macOS and Linux.
# Unpublished owners and abandoned recovery claims expire after 60 seconds.
host_slot_paths=()
host_slots_acquired=0
host_slots_capacity=0
host_slots_owner="$$"

# stat flags differ between GNU and BSD; neither requires a new dependency.
host_slot_stale() {
  local modified now
  modified="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)" || return 1
  [[ "$modified" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  ((now - modified >= 60))
}

host_slot_take() {
  local path="$1" owner="" current="" reclaiming=0 unpublished_stale=0
  if ! mkdir "$path" 2>/dev/null; then
    if [[ -r "$path/owner.pid" ]]; then read -r owner < "$path/owner.pid" || true; fi
    if [[ "$owner" =~ ^[1-9][0-9]*$ ]]; then
      if kill -0 "$owner" 2>/dev/null; then return 1; fi
    else
      # A signal between mkdir and publication must not lose the slot forever.
      host_slot_stale "$path" || return 1
      unpublished_stale=1
    fi
    # As in the installer lock, retain the slot directory while replacing its
    # dead owner. Serialize reclaimers, then recheck before publishing our PID.
    if ! mkdir "$path/reclaim" 2>/dev/null; then
      # A killed reclaimer may leave its empty claim behind. rmdir refuses
      # nonempty claims and avoids recursively removing somebody else's files.
      host_slot_stale "$path/reclaim" || return 1
      rmdir "$path/reclaim" 2>/dev/null || return 1
      mkdir "$path/reclaim" 2>/dev/null || return 1
    fi
    if [[ -r "$path/owner.pid" ]]; then read -r current < "$path/owner.pid" || true; fi
    if [[ "$current" != "$owner" ]] || { [[ "$unpublished_stale" -eq 0 ]] && kill -0 "$current" 2>/dev/null; }; then
      rmdir "$path/reclaim" 2>/dev/null || true
      return 1
    fi
    reclaiming=1
  fi
  host_slot_paths+=("$path")
  if ! printf '%s\n' "$host_slots_owner" > "$path/owner.pid"; then
    rm -f "$path/owner.pid"
    if [[ "$reclaiming" -eq 1 ]]; then rmdir "$path/reclaim" 2>/dev/null || true; fi
    rmdir "$path" 2>/dev/null || true
    return 1
  fi
  if [[ "$reclaiming" -eq 1 ]]; then rmdir "$path/reclaim" 2>/dev/null || true; fi
  host_slots_acquired=$((host_slots_acquired + 1))
}

host_slots_acquire() {
  local demand="$1" cores="$2" capacity index coordination
  capacity="${AUTOMOBILE_HOST_TEST_SLOTS:-$(((cores + 1) / 2))}"
  if [[ -z "${AUTOMOBILE_HOST_TEST_SLOTS:-}" && "$capacity" -lt 2 ]]; then capacity=2; fi
  if [[ "$capacity" == off ]]; then host_slots_acquired="$demand"; return 0; fi
  if ! [[ "$capacity" =~ ^[1-9][0-9]{0,8}$ ]]; then
    echo "AUTOMOBILE_HOST_TEST_SLOTS must be a positive integer below 1000000000 or off, got: $capacity" >&2
    return 2
  fi
  # Mirror getSharedAutoMobileDir in src/utils/tempDir.ts, including the legacy
  # override. Worktrees must use the same home/override to share the pool.
  coordination="${AUTOMOBILE_COORDINATION_DIR:-${AUTO_MOBILE_COORDINATION_DIR:-${HOME}/.auto-mobile}}"
  if [[ "$coordination" != /* ]]; then
    echo 'AUTOMOBILE_COORDINATION_DIR must be an absolute path' >&2
    return 2
  fi
  if ! mkdir -p "$coordination/test-slots" 2>/dev/null; then
    echo "test-ts: warning: cannot create host slot pool at $coordination/test-slots; running uncapped" >&2
    host_slots_acquired="$demand"
    return 0
  fi
  # The base pool size, for callers that must know whether they hold all of it (#14450).
  # shellcheck disable=SC2034 # read by scripts/lib/host-heavy-run.sh
  host_slots_capacity="$capacity"
  host_slots_acquired=0
  for ((index = 0; index < capacity && host_slots_acquired < demand; index += 1)); do
    host_slot_take "$coordination/test-slots/$index" || true
  done
  # Only a holder of the entire base pool can oversubscribe it. No CI special
  # case: an idle hosted runner retains today's full worker demand too.
  if [[ "$host_slots_acquired" -eq "$capacity" ]]; then
    for ((index = capacity; index < demand; index += 1)); do
      host_slot_take "$coordination/test-slots/$index" || true
    done
  fi
}

host_slots_release() {
  local path owner
  for path in ${host_slot_paths[@]+"${host_slot_paths[@]}"}; do
    owner=""
    if [[ -r "$path/owner.pid" ]]; then read -r owner < "$path/owner.pid" || true; fi
    if [[ "$owner" == "$host_slots_owner" ]]; then
      rm -f "$path/owner.pid"
      rmdir "$path/reclaim" 2>/dev/null || true
      rmdir "$path" 2>/dev/null || true
    fi
  done
  host_slot_paths=()
}
