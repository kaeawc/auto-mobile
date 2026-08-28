#!/usr/bin/env bats

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="${TEST_ROOT}/home"
  STUB_BIN="${TEST_ROOT}/bin"
  mkdir -p "${TEST_HOME}/Applications/AutoMobile.app/Contents" "${STUB_BIN}"
  printf '%s\n' '<plist><dict><key>CFBundleIdentifier</key><string>dev.jasonpearson.automobile.desktop</string></dict></plist>' > "${TEST_HOME}/Applications/AutoMobile.app/Contents/Info.plist"
  printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "${STUB_BIN}/uname"
  cat > "${STUB_BIN}/plutil" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$1" == "-extract" && "$2" == "CFBundleIdentifier" && "$3" == "raw" ]]; then
  sed -n 's|.*<string>\([^<]*\)</string>.*|\1|p' "$4"
fi
SCRIPT
  chmod +x "${STUB_BIN}/uname" "${STUB_BIN}/plutil"

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

@test "refuses removal when desktop process enumeration fails" {
  desktop_app_process_table() { return 1; }
  local stop_status

  if stop_desktop_app_processes; then
    stop_status=0
  else
    stop_status=$?
  fi

  [ "${stop_status}" -eq 1 ]
}

@test "stops the desktop process before removal with a bounded TERM path" {
  local terminated=false
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_pid_command() {
    [[ "${terminated}" != "true" ]] || return 1
    printf '%s\n' "/Applications/AutoMobile.app/Contents/MacOS/AutoMobile"
  }
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
  local terminated=false killed=false waits=0 stop_status
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_pid_command() { printf '%s\n' "/Applications/AutoMobile.app/Contents/MacOS/AutoMobile"; }
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

  if stop_desktop_app_processes; then
    stop_status=0
  else
    stop_status=$?
  fi

  [ "${stop_status}" -eq 1 ]
  [ "${terminated}" = "true" ]
  [ "${killed}" = "true" ]
  [ "${waits}" -eq 40 ]
}

@test "refuses removal when a live desktop PID cannot be inspected" {
  local signalled=false stop_status
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_pids() { printf '101\n'; }
  run_desktop_app_privileged() {
    case "$1" in
      ps) return 1 ;;
      kill)
        [[ "$2" == "-0" ]] && return 0
        signalled=true
        ;;
    esac
  }

  if stop_desktop_app_processes; then
    stop_status=0
  else
    stop_status=$?
  fi

  [ "${stop_status}" -eq 1 ]
  [ "${signalled}" = "false" ]
}

@test "does not signal a process whose PID was reused after TERM" {
  local terminated=false killed=false
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_termination_wait() { :; }
  desktop_app_pid_command() {
    if [[ "${terminated}" == "true" ]]; then
      printf '%s\n' '/usr/bin/unrelated-process'
    else
      printf '%s\n' "/Applications/AutoMobile.app/Contents/MacOS/AutoMobile"
    fi
  }
  kill() {
    case "$1" in
      -TERM) terminated=true ;;
      -KILL) killed=true ;;
      -0) return 0 ;;
    esac
  }

  stop_desktop_app_processes

  [ "${terminated}" = "true" ]
  [ "${killed}" = "false" ]
}

@test "treats a PID that exits after TERM as stopped" {
  local terminated=false stop_status
  DESKTOP_APP_EXECUTABLES=("/Applications/AutoMobile.app/Contents/MacOS/AutoMobile")
  desktop_app_process_pids() { printf '101\n'; }
  desktop_app_pid_command() {
    [[ "${terminated}" != "true" ]] || return 1
    printf '%s\n' "/Applications/AutoMobile.app/Contents/MacOS/AutoMobile"
  }
  desktop_app_termination_wait() { :; }
  kill() {
    case "$1" in
      -TERM) terminated=true ;;
      -0) [[ "${terminated}" != "true" ]] ;;
    esac
  }

  if stop_desktop_app_processes; then
    stop_status=0
  else
    stop_status=$?
  fi

  [ "${stop_status}" -eq 0 ]
  [ "${terminated}" = "true" ]
}

@test "runs desktop removal commands directly when already root" {
  desktop_app_is_root() { return 0; }
  sudo() { printf 'sudo should not be called\n'; return 1; }
  root_command() { printf 'ran directly\n'; }

  run run_desktop_app_privileged root_command

  [ "$status" -eq 0 ]
  [ "$output" = "ran directly" ]
}

@test "uses the privileged removal path for a system Applications bundle" {
  DESKTOP_APP_INSTALLED=true
  DESKTOP_APP_PATHS=("/Applications/AutoMobile.app")
  detect_os() { printf 'macos\n'; }
  run_desktop_app_privileged() { printf 'privileged: %s\n' "$*"; }

  run remove_desktop_app

  [ "$status" -eq 0 ]
  [[ "$output" == *"privileged: rm"* ]]
  [[ "$output" == *"/Applications/AutoMobile.app"* ]]
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

@test "does not remove an unrelated AutoMobile.app bundle" {
  printf '%s\n' '<plist><dict><key>CFBundleIdentifier</key><string>com.example.unrelated</string></dict></plist>' > "${TEST_HOME}/Applications/AutoMobile.app/Contents/Info.plist"

  run env HOME="${TEST_HOME}" PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" --all --force

  [ "$status" -eq 0 ]
  [ -d "${TEST_HOME}/Applications/AutoMobile.app" ]
  [[ "$output" == *"No AutoMobile components found to uninstall"* ]]
}
