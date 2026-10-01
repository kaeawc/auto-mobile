#!/usr/bin/env bash

# Installs an EXIT trap that releases an acquired daemon session exactly once.
# Call only after the session UUID has been parsed successfully.
install_session_release_trap() {
  session_release_uuid="$1"
  session_release_done=0
  trap session_release_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# shellcheck disable=SC2317
session_release_on_exit() {
  local original_status=$?
  trap - EXIT
  if [[ "${session_release_done}" -eq 0 ]]; then
    session_release_done=1
    if ! AUTOMOBILE_DAEMON_TIMEOUT_MS=2000 auto-mobile --daemon release-session "${session_release_uuid}" > /dev/null; then
      echo "warning: could not release session ${session_release_uuid}" >&2
    fi
  fi
  exit "${original_status}"
}
