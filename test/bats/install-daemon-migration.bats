#!/usr/bin/env bats

@test "stale daemon migration can be disabled for an isolated installer run" {
  run env AUTOMOBILE_SKIP_STALE_DAEMON_MIGRATION=true INSTALL_SH_SOURCE_ONLY=true bash -c '
    source scripts/install.sh
    log_info() { printf "%s\n" "$1"; }
    is_daemon_running() {
      echo "daemon probe must not run" >&2
      return 1
    }
    migrate_stale_daemon
  '

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping stale daemon migration"* ]]
  [[ "$output" != *"daemon probe must not run"* ]]
}
