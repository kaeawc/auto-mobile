#!/usr/bin/env bats

LIB="scripts/lib/auto-mobile-log-dir.sh"

@test "prefers a trimmed AUTOMOBILE_LOG_DIR over the legacy alias" {
  run bash -c '
    source "$1"
    AUTOMOBILE_LOG_DIR="  /var/log/auto-mobile  "
    AUTO_MOBILE_LOG_DIR="/legacy/logs"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/var/log/auto-mobile" ]
}

@test "resolves a relative legacy override from the daemon launch directory" {
  run bash -c '
    source "$1"
    AUTO_MOBILE_LOG_DIR=" logs/daemon "
    AUTOMOBILE_DAEMON_LAUNCH_CWD="/workspace/auto-mobile"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/workspace/auto-mobile/logs/daemon" ]
}

@test "normalizes dot segments in a relative override" {
  run bash -c '
    source "$1"
    AUTOMOBILE_LOG_DIR="missing/../logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="/workspace/auto-mobile"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/workspace/auto-mobile/logs" ]
}

@test "trims the daemon launch directory before resolving a relative override" {
  run bash -c '
    source "$1"
    AUTOMOBILE_LOG_DIR="logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="  /workspace/auto-mobile  "
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/workspace/auto-mobile/logs" ]
}

@test "uses the owner-controlled home directory when no override is set" {
  run bash -c '
    source "$1"
    HOME="/home/tester"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/home/tester/.auto-mobile/logs" ]
}

@test "uses an owned home log directory that runtime can repair" {
  run bash -c '
    source "$1"
    tmp="$(mktemp -d)"
    trap "chmod 700 \"$tmp/home/.auto-mobile/logs\" 2>/dev/null || true; rm -rf \"$tmp\"" EXIT
    HOME="$tmp/home"
    AUTOMOBILE_DATA_DIR="$tmp/data"
    mkdir -p "$HOME/.auto-mobile/logs"
    chmod 000 "$HOME/.auto-mobile/logs"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [[ "$output" == */home/.auto-mobile/logs ]]
}

@test "normalizes dot segments in an absolute home directory" {
  run bash -c '
    source "$1"
    tmp="$(mktemp -d)"
    trap "rm -rf \"$tmp\"" EXIT
    HOME="$tmp/missing/../actual"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [[ "$output" == */actual/.auto-mobile/logs ]]
}

@test "treats an empty primary override as authoritative over the legacy alias" {
  run bash -c '
    source "$1"
    HOME="/home/tester"
    AUTOMOBILE_LOG_DIR=""
    AUTO_MOBILE_LOG_DIR="/legacy/logs"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/home/tester/.auto-mobile/logs" ]
}

@test "converts an absolute Windows override to a Git Bash path" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="C:\\logs\\auto-mobile"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "C:\\logs\\auto-mobile" ]
      printf "/c/logs/auto-mobile\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/c/logs/auto-mobile" ]
}

@test "converts a drive-relative Windows override with Windows path semantics" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="C:logs"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "C:logs" ]
      printf "/c/daemon-cwd/logs\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/c/daemon-cwd/logs" ]
}

@test "converts a forward-slash UNC Windows override to a Git Bash path" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="//server/share/logs"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "//server/share/logs" ]
      printf "//server/share/logs\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "//server/share/logs" ]
}

@test "resolves a slash-rooted Windows override from the launch drive" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="/c/logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="D:\\launch"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "D:\\launch" ]
      printf "/d/launch\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/d/c/logs" ]
}

@test "uses the Windows profile directory for the default in Git Bash" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    USERPROFILE="C:\\Users\\tester"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "C:\\Users\\tester" ]
      printf "/c/Users/tester\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/c/Users/tester/.auto-mobile/logs" ]
}

@test "uses HOMEDRIVE and HOMEPATH when the Windows profile variable is unset" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    unset HOME USERPROFILE
    HOMEDRIVE="D:"
    HOMEPATH="\\Users\\tester"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "D:\\Users\\tester" ]
      printf "/d/Users/tester\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/d/Users/tester/.auto-mobile/logs" ]
}

@test "uses the Windows temp directory and username when no account home is available" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    unset HOME USERPROFILE HOMEDRIVE HOMEPATH
    USERNAME="tester"
    TEMP="C:\\Windows\\Temp"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "C:\\Windows\\Temp" ]
      printf "/c/Windows/Temp\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/c/Windows/Temp/auto-mobile-tester" ]
}

@test "resolves the Unix account home when HOME is unset" {
  run bash -c '
    source "$1"
    unset HOME
    id() {
      if [ "$1" = "-u" ]; then
        printf "4242\n"
      else
        printf "tester\n"
      fi
    }
    getent() {
      [ "$1" = "passwd" ]
      [ "$2" = "4242" ]
      printf "tester:x:4242:4242:Tester:/home/tester:/bin/bash\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/home/tester/.auto-mobile/logs" ]
}

@test "preserves spaces in the macOS account home when HOME is unset" {
  run bash -c '
    source "$1"
    unset HOME
    id() {
      if [ "$1" = "-u" ]; then
        printf "4242\n"
      else
        printf "tester\n"
      fi
    }
    command() {
      if [ "$1" = "-v" ] && [ "$2" = "getent" ]; then
        return 1
      fi
      if [ "$1" = "-v" ] && [ "$2" = "dscl" ]; then
        return 0
      fi
      builtin command "$@"
    }
    dscl() {
      [ "$1" = "." ]
      [ "$2" = "-read" ]
      [ "$3" = "/Users/tester" ]
      [ "$4" = "NFSHomeDirectory" ]
      printf "NFSHomeDirectory: /Volumes/My Disk/tester\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/Volumes/My Disk/tester/.auto-mobile/logs" ]
}

@test "falls back to the configured data directory when the home is unusable" {
  run bash -c '
    source "$1"
    HOME="/dev/null"
    AUTOMOBILE_DATA_DIR="/tmp/auto-mobile-data"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/auto-mobile-data/logs" ]
}

@test "falls back from a missing top-level home component without looping" {
  run bash -c '
    source "$1"
    HOME="/nonexistent"
    AUTOMOBILE_DATA_DIR="/tmp/auto-mobile-data"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/auto-mobile-data/logs" ]
}

@test "resolves a relative home path without hanging" {
  run bash -c '
    source "$1"
    expected="/tmp/auto-mobile-data/logs"
    HOME="relative"
    AUTOMOBILE_DATA_DIR="/tmp/auto-mobile-data"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="/launch"
    ( sleep 1; kill -TERM "$$" 2>/dev/null ) &
    watchdog="$!"
    trap "kill \"$watchdog\" 2>/dev/null || true" EXIT
    result="$(resolve_automobile_log_dir)"
    result_status="$?"
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    trap - EXIT
    [ "$result_status" -eq 0 ]
    [ "$result" = "$expected" ]
  ' _ "$LIB"

  [ "$status" -eq 0 ]
}

@test "anchors a relative data fallback to the daemon launch directory" {
  run bash -c '
    source "$1"
    HOME="/dev/null"
    AUTOMOBILE_DATA_DIR="relative-data"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="/launch"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/launch/relative-data/logs" ]
}

@test "falls back from a symlinked home log directory" {
  run bash -c '
    source "$1"
    tmp="$(mktemp -d)"
    trap "rm -rf \"$tmp\"" EXIT
    HOME="$tmp/home"
    AUTOMOBILE_DATA_DIR="$tmp/data"
    mkdir -p "$HOME/.auto-mobile" "$tmp/target"
    ln -s "$tmp/target" "$HOME/.auto-mobile/logs"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [[ "$output" == */data/logs ]]
}

@test "falls back from a dangling home-directory symlink" {
  run bash -c '
    source "$1"
    tmp="$(mktemp -d)"
    trap "rm -rf \"$tmp\"" EXIT
    HOME="$tmp/home"
    AUTOMOBILE_DATA_DIR="$tmp/data"
    mkdir -p "$HOME"
    ln -s "$tmp/missing" "$HOME/.auto-mobile"
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [[ "$output" == */data/logs ]]
}

@test "falls back when an existing home log directory cannot be secured" {
  run bash -c '
    source "$1"
    tmp="$(mktemp -d)"
    trap "rm -rf \"$tmp\"" EXIT
    HOME="$tmp/home"
    AUTOMOBILE_DATA_DIR="$tmp/data"
    mkdir -p "$HOME/.auto-mobile/logs"
    automobile_directory_is_owned_by_current_user() { return 1; }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [[ "$output" == */data/logs ]]
}

@test "converts a drive-absolute Windows data fallback to a Git Bash path" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    HOME="/dev/null"
    AUTOMOBILE_DATA_DIR="D:\\auto-data"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "D:\\auto-data" ]
      printf "/d/auto-data\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/d/auto-data/logs" ]
}

@test "resolves a slash-rooted Windows data fallback from the launch drive" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    HOME="/dev/null"
    AUTOMOBILE_DATA_DIR="/d/data"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="C:\\launch"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "C:\\launch" ]
      printf "/c/launch\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "/c/d/data/logs" ]
}

@test "preserves a UNC root for a Windows data fallback" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    HOME="/dev/null"
    AUTOMOBILE_DATA_DIR="\\\\server\\share\\auto-data"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "\\\\server\\share\\auto-data" ]
      printf "//server/share/auto-data\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "//server/share/auto-data/logs" ]
}

@test "preserves a UNC launch root for a relative Windows override" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="\\\\server\\share\\launch"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "\\\\server\\share\\launch" ]
      printf "//server/share/launch\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "//server/share/launch/logs" ]
}

@test "does not resolve a relative Windows override above a UNC share root" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="../../logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="\\\\server\\share\\launch"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "\\\\server\\share\\launch" ]
      printf "//server/share/launch\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "//server/share/logs" ]
}

@test "resolves a slash-rooted Windows override from a UNC share root" {
  run bash -c '
    source "$1"
    OS="Windows_NT"
    AUTOMOBILE_LOG_DIR="/logs"
    AUTOMOBILE_DAEMON_LAUNCH_CWD="\\\\server\\share\\launch"
    cygpath() {
      [ "$1" = "-u" ]
      [ "$2" = "\\\\server\\share\\launch" ]
      printf "//server/share/launch\n"
    }
    resolve_automobile_log_dir
  ' _ "$LIB"

  [ "$status" -eq 0 ]
  [ "$output" = "//server/share/logs" ]
}
