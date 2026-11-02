#!/usr/bin/env bash

# Installs an EXIT trap that releases an acquired daemon session exactly once.
# Call only after the session UUID has been parsed successfully.
install_session_release_trap() {
  session_release_uuid="$1"
  session_release_done=0
  trap 'session_release_on_exit' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# Preserve runtime options through the entrypoint, then drop CLI options.
session_release_run_cli() {
  local -a words=(auto-mobile) cli_words=()
  local word has_entrypoint=0 after_entrypoint=0
  if [[ -n "${AUTO_MOBILE_CMD:-}" ]]; then
    read -r -a cli_words <<< "$AUTO_MOBILE_CMD"
    for word in ${cli_words[@]+"${cli_words[@]}"}; do
      case "$word" in
        *.ts | *.js | *.mjs | *.cjs | *.mts | *.cts) has_entrypoint=1; break ;;
      esac
    done
    words=()
    for word in ${cli_words[@]+"${cli_words[@]}"}; do
      if [[ "$word" == --* ]] && [[ "$has_entrypoint" == 0 || "$after_entrypoint" == 1 ]]; then
        break
      fi
      words+=("$word")
      case "$word" in
        *.ts | *.js | *.mjs | *.cjs | *.mts | *.cts) after_entrypoint=1 ;;
      esac
    done
  fi
  "${words[@]+"${words[@]}"}" "$@"
}

session_release_on_exit() {
  local original_status=$?
  trap - EXIT
  if [[ "${session_release_done}" -eq 0 ]]; then
    session_release_done=1
    if ! AUTOMOBILE_DAEMON_TIMEOUT_MS=2000 session_release_run_cli --daemon release-session "${session_release_uuid}" > /dev/null; then
      echo "warning: could not release session ${session_release_uuid}" >&2
    fi
  fi
  exit "${original_status}"
}
