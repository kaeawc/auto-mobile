#!/usr/bin/env bats

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="${TEST_ROOT}/home"
  STUB_BIN="${TEST_ROOT}/bin"
  mkdir -p "${TEST_HOME}/Applications/AutoMobile.app/Contents" "${STUB_BIN}"
  printf '%s\n' '<plist/>' > "${TEST_HOME}/Applications/AutoMobile.app/Contents/Info.plist"
  printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "${STUB_BIN}/uname"
  chmod +x "${STUB_BIN}/uname"

  UNINSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source "${SCRIPT}"
  unset UNINSTALL_SH_SOURCE_ONLY
}

@test "matches only an exact installed desktop executable path" {
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_table() {
    printf '%s\n' \
      '101 /Applications/AutoMobile.app/Contents/MacOS/AutoMobile' \
      '102 /Applications/AutoMobile.app/Contents/MacOS/AutoMobile --flag' \
      '103 /tmp/AutoMobile' \
      '104 sh -c /Applications/AutoMobile.app/Contents/MacOS/AutoMobile'
  }

  run desktop_app_process_pids

  [ "$status" -eq 0 ]
  [ "$output" = $'101\n102' ]
}

@test "stops the desktop process before removal with a bounded TERM path" {
  local terminated=false
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_termination_wait() { :; }
  kill() {
    case "$1" in
      -TERM)
        terminated=true
        ;;
      -0)
        [[ "${terminated}" != "true" ]]
        ;;
      *)
        return 0
        ;;
    esac
  }

  stop_desktop_app_processes

  [ "${terminated}" = "true" ]
}

@test "force-stops a desktop process that ignores the bounded TERM wait" {
  local terminated=false killed=false waits=0
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_termination_wait() { ((waits += 1)); }
  kill() {
    case "$1" in
      -TERM)
        terminated=true
        ;;
      -0)
        return 0
        ;;
      -KILL)
        killed=true
        ;;
    esac
  }

  stop_desktop_app_processes

  [ "${terminated}" = "true" ]
  [ "${killed}" = "true" ]
  [ "${waits}" -eq 20 ]
}

@test "runs desktop removal commands directly when already root" {
  desktop_app_is_root() { return 0; }
  sudo() { printf 'sudo should not be called\n'; return 1; }
  root_command() { printf 'ran directly\n'; }

  run run_desktop_app_privileged root_command

  [ "$status" -eq 0 ]
  [ "$output" = "ran directly" ]
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

@test "--all removes a desktop app installed in the user's Applications directory" {
  run env HOME="${TEST_HOME}" PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" --all --force

  [ "$status" -eq 0 ]
  [ ! -e "${TEST_HOME}/Applications/AutoMobile.app" ]
  [[ "$output" == *"AutoMobile desktop app removed"* ]]
}

@test "dry-run detects but does not remove the desktop app" {
  run env HOME="${TEST_HOME}" PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" --all --dry-run --force

  [ "$status" -eq 0 ]
  [ -d "${TEST_HOME}/Applications/AutoMobile.app" ]
  [[ "$output" == *"[DRY-RUN] Would remove ${TEST_HOME}/Applications/AutoMobile.app"* ]]
}
