#!/usr/bin/env bash
# Overlap an optional prebuild with a foreground command; prebuild failure only warns.
set -euo pipefail

if [[ $# -lt 3 || "$2" != -- ]]; then
  echo 'usage: run-with-background-prebuild.sh <prebuild-command> -- <command> [args...]' >&2
  exit 2
fi
prebuild_command="$1"
shift 2
if [[ -z "$prebuild_command" ]]; then
  exec "$@"
fi

tmp_dir="$(mktemp -d)"
prebuild_pid=""
# Descendants belong to the prebuild this script started. Terminate deepest first.
terminate_tree() {
  local pid="$1" child attempt
  for child in $(pgrep -P "$pid" || true); do
    terminate_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
  # Give its parent a bounded chance to reap it before terminating the parent.
  for ((attempt = 0; attempt < 10; attempt++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.01
  done
  kill -KILL "$pid" 2>/dev/null || true
}
terminate_prebuild() {
  if [[ -n "$prebuild_pid" ]] && kill -0 "$prebuild_pid" 2>/dev/null; then
    terminate_tree "$prebuild_pid"
  fi
}
# shellcheck disable=SC2317,SC2329 # Invoked by the EXIT trap.
cleanup() {
  terminate_prebuild
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

bash -c "$prebuild_command" > "$tmp_dir/output.log" 2>&1 < /dev/null &
prebuild_pid=$!
echo "[prebuild] started in the background: $prebuild_command"
foreground_status=0
"$@" || foreground_status=$?

if [[ "$foreground_status" -ne 0 ]]; then
  terminate_prebuild
else
  budget="${AUTOMOBILE_PREBUILD_WAIT_SECONDS:-600}"
  poll="${AUTOMOBILE_PREBUILD_POLL_SECONDS:-1}"
  deadline=$((SECONDS + budget))
  if kill -0 "$prebuild_pid" 2>/dev/null; then
    echo "[prebuild] waiting up to ${budget}s for the background prebuild"
  fi
  while kill -0 "$prebuild_pid" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      terminate_prebuild
      echo "::warning::background prebuild did not finish within ${budget}s; terminated"
      break
    fi
    sleep "$poll"
  done
fi
prebuild_status=0
wait "$prebuild_pid" 2>/dev/null || prebuild_status=$?
prebuild_pid=""
echo '::group::Background prebuild output'
cat "$tmp_dir/output.log"
echo '::endgroup::'
if [[ "$prebuild_status" -eq 0 ]]; then
  echo '[prebuild] finished with exit status 0'
else
  echo "::warning::background prebuild exited with status ${prebuild_status}; the suites will build what they need themselves"
fi
exit "$foreground_status"
