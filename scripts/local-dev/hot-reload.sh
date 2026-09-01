#!/usr/bin/env bash
#
# AutoMobile hot-reload development workflow.
#
# Builds all components, then launches a background watcher that monitors for
# changes and rebuilds/restarts as needed. The script exits after setup; the
# background watcher keeps running until another invocation replaces it or
# the timeout expires (default 60 minutes).
#
# Components watched (in order):
#   1. Desktop app (Compose Desktop via desktop-core + desktop-app)
#   2. Android AccessibilityService + video server (with sha updates for TypeScript)
#   3. iOS CtrlProxy (with sha updates for TypeScript)
#   4. MCP TypeScript daemon
#
# Usage:
#   ./scripts/local-dev/hot-reload.sh [options]
#
# Options:
#   --device <id>        Target specific ADB device
#   --simulator <udid>   Target specific iOS simulator
#   --once               Build all components once and exit
#   --poll-interval <s>  File watch interval (default: 2)
#   --timeout <m>        Background watcher timeout in minutes (default: 60)
#   --manage-ios-runner  Let the watcher own the CtrlProxy iOS runner lifecycle
#                        (start/stop/restart). Off by default; the MCP daemon
#                        solely owns the runner so the two don't race on :8765.
#   --help               Show help
#
# Environment:
#   ANDROID_SERIAL       ADB device id override
#   CTRL_PROXY_IOS_PORT   Override CtrlProxy iOS port (default: 8765)
#   HOT_RELOAD_MANAGE_IOS_RUNNER  Set to "true" to make the watcher own the
#                        CtrlProxy iOS runner (same as --manage-ios-runner).
#
# Daemons restarted by this script are pinned to the locally-built CtrlProxy APK
# (AUTOMOBILE_CTRL_PROXY_APK_PATH + AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED)
# so they cannot reinstall a released APK over it. Note this only covers daemons
# THIS script starts: another checkout's daemon sharing the socket will still
# replace the APK. If a runner-gated change seems missing, check what is actually
# installed:
#   adb shell dumpsys package dev.jasonpearson.automobile.ctrlproxy | grep versionName

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export PROJECT_ROOT

# Source library files
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/deps.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/adb.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/apk.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/ide-plugin.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/ctrl-proxy-ios.sh"

# Path constants
ANDROID_DIR="${PROJECT_ROOT}/android"
SERVICE_DIR="${ANDROID_DIR}/control-proxy"
APK_PATH="${SERVICE_DIR}/build/outputs/apk/debug/control-proxy-debug.apk"
VIDEO_SERVER_DIR="${ANDROID_DIR}/video-server"
VIDEO_SERVER_JAR_PATH="${VIDEO_SERVER_DIR}/build/libs/automobile-video.jar"
VIDEO_SERVER_REMOTE_JAR_PATH="/data/local/tmp/automobile-video.jar"
CTRL_PROXY_IOS_DIR="${PROJECT_ROOT}/ios/control-proxy"
DERIVED_DATA_PATH="/tmp/automobile-ctrl-proxy"
PID_FILE="${PROJECT_ROOT}/.automobile-hot-reload.pid"

# CLI options with defaults
DEVICE_ID=""
SIMULATOR_ID=""
RUN_ONCE=false
POLL_INTERVAL=2
TIMEOUT_MINUTES=60
# By default the MCP daemon's ensureCtrlProxy solely owns the CtrlProxy iOS
# runner. The watcher only rebuilds iOS source and nudges the daemon to reload.
# Set HOT_RELOAD_MANAGE_IOS_RUNNER=true (or pass --manage-ios-runner) to restore
# the legacy behavior where the watcher starts/stops/restarts the runner itself.
MANAGE_IOS_RUNNER="${HOT_RELOAD_MANAGE_IOS_RUNNER:-false}"

# Runtime state
DESKTOP_APP_ENABLED=false
ANDROID_ENABLED=false
IOS_ENABLED=false
HAVE_DEVICE=false

# Track last hashes for change detection. Desktop app has no hash: Compose Hot
# Reload (hotRun --autoReload) watches and reloads its own source live.
LAST_APK_HASH=""
LAST_VIDEO_SERVER_HASH=""
LAST_IOS_HASH=""
LAST_TS_HASH=""

# Track device/simulator state
LAST_ADB_DEVICES=""
LAST_SIMULATOR=""
CTRL_PROXY_SIMULATOR=""      # Simulator CtrlProxy is currently targeting
APK_NEEDS_INSTALL=false
VIDEO_SERVER_NEEDS_INSTALL=false
ANDROID_VIDEO_SERVER_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=false
IOS_NEEDS_RESTART=false
IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=false

# Desktop crash-relaunch backoff. If hotRun exits immediately (e.g. a hot-reload
# config failure), relaunching every poll interval would hammer Gradle for the
# whole watcher lifetime and repeatedly clobber the diagnostic log. Cap attempts
# and back off exponentially; reset only once the app has stayed up a while.
DESKTOP_RELAUNCH_ATTEMPTS=0
DESKTOP_RELAUNCH_NEXT_TS=0
DESKTOP_LAST_LAUNCH_TS=0
DESKTOP_RELAUNCH_MAX=5
DESKTOP_RELAUNCH_BACKOFF_CAP=300  # seconds
DESKTOP_RELAUNCH_STABLE_SECS=30   # uptime before a launch is deemed healthy

usage() {
  cat << EOF
Usage: $0 [options]

AutoMobile unified hot-reload development workflow.

Watches all components in a single loop:
  1. Desktop app (Compose Desktop)
  2. Android AccessibilityService + video server (with sha updates)
  3. iOS CtrlProxy (with sha updates)
  4. MCP TypeScript daemon

Options:
  --device <id>        Target specific ADB device
  --simulator <udid>   Target specific iOS simulator
  --once               Build all components once and exit
  --poll-interval <s>  File watch interval (default: 2)
  --timeout <m>        Background watcher timeout in minutes (default: 60)
  --manage-ios-runner  Let the watcher own the CtrlProxy iOS runner lifecycle.
                       Off by default; the MCP daemon solely owns the runner so
                       the two don't race on port 8765. The watcher still
                       rebuilds iOS source and reloads the daemon to apply it.
  --help               Show this help text

Environment variables:
  ANDROID_SERIAL       ADB device id override
  CTRL_PROXY_IOS_PORT   Override CtrlProxy iOS port (default: 8765)
  HOT_RELOAD_MANAGE_IOS_RUNNER  "true" => same as --manage-ios-runner
EOF
}

kill_ctrl_proxy_ios_xcodebuild_processes() {
  # The sourced runner helper persists the exact watcher-owned PID. Never scan
  # or signal other worktrees' or simulators' xcodebuild processes.
  stop_ctrl_proxy_ios || true
}

# Kill any previous hot-reload processes
kill_previous() {
  if [[ -f "${PID_FILE}" ]]; then
    local old_pid
    old_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      log_info "Killing previous hot-reload process (PID ${old_pid})..."
      kill "${old_pid}" 2>/dev/null || true
      # Wait up to 10 seconds for graceful shutdown (allows CtrlProxy iOS cleanup)
      local count=0
      while kill -0 "${old_pid}" 2>/dev/null && [[ ${count} -lt 10 ]]; do
        sleep 1
        count=$((count + 1))
      done
      if kill -0 "${old_pid}" 2>/dev/null; then
        log_warn "Force killing previous watcher..."
        kill -9 "${old_pid}" 2>/dev/null || true
      fi
    fi
    rm -f "${PID_FILE}"
  fi

  local pids
  pids=$(pgrep -f "hot-reload.sh" 2>/dev/null | grep -vxF "$$" || true)
  if [[ -n "${pids}" ]]; then
    log_info "Killing orphaned hot-reload processes..."
    echo "${pids}" | xargs kill 2>/dev/null || true
    sleep 1
    # Force kill if still running
    pids=$(pgrep -f "hot-reload.sh" 2>/dev/null | grep -vxF "$$" || true)
    if [[ -n "${pids}" ]]; then
      log_warn "Force killing orphaned hot-reload processes..."
      echo "${pids}" | xargs kill -9 2>/dev/null || true
    fi
  fi

  # Clean only the runner PID persisted by this watcher. In daemon-owned mode,
  # do not touch any xcodebuild process.
  if [[ "${MANAGE_IOS_RUNNER}" == "true" ]]; then
    kill_ctrl_proxy_ios_xcodebuild_processes
  fi
}

# Reload MCP daemon by restarting the daemon process
reload_mcp_daemon() {
  local skip_ios_build="${1:-auto}"
  local should_skip_ios_build=false
  local daemon_env=()

  if [[ "${skip_ios_build}" == "true" ]] || \
    [[ "${skip_ios_build}" == "auto" && "${IOS_ENABLED}" == "true" && "${MANAGE_IOS_RUNNER}" != "true" ]]; then
    should_skip_ios_build=true
  fi

  if [[ -f "${VIDEO_SERVER_JAR_PATH}" ]]; then
    daemon_env+=("AUTOMOBILE_VIDEO_SERVER_JAR=${VIDEO_SERVER_JAR_PATH}")
  fi

  # Pin the daemon to the APK this watcher just built. update_checksum() rewrites
  # src/constants/release.ts so the local sha256 is the expected one, but that
  # only takes effect once TypeScript is rebuilt — and the daemon is restarted
  # before that happens on the initial run. Without these the daemon compares
  # against the stale compiled-in checksum, treats the fresh APK as unknown, and
  # reinstalls the released one, silently downgrading the build being iterated on.
  if [[ -f "${APK_PATH}" ]]; then
    daemon_env+=("AUTOMOBILE_CTRL_PROXY_APK_PATH=${APK_PATH}")
    daemon_env+=("AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED=true")
  fi

  log_info "Restarting MCP daemon..."
  if command -v auto-mobile >/dev/null 2>&1; then
    # Run daemon restart in background with timeout to prevent hanging
    local daemon_log="${PROJECT_ROOT}/scratch/daemon-restart.log"
    if [[ "${should_skip_ios_build}" == "true" ]]; then
      env AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true ${daemon_env[@]+"${daemon_env[@]}"} \
        auto-mobile --daemon restart --debug --debug-perf > "${daemon_log}" 2>&1 &
    else
      env ${daemon_env[@]+"${daemon_env[@]}"} \
        auto-mobile --daemon restart --debug --debug-perf > "${daemon_log}" 2>&1 &
    fi
    local daemon_pid=$!

    # Wait up to 30 seconds for daemon restart
    local count=0
    while kill -0 "${daemon_pid}" 2>/dev/null && [[ ${count} -lt 30 ]]; do
      sleep 1
      count=$((count + 1))
    done

    if kill -0 "${daemon_pid}" 2>/dev/null; then
      log_warn "Daemon restart timed out, force killing..."
      kill -9 "${daemon_pid}" 2>/dev/null || true
      # Also kill any daemon processes
      local pids
      pids=$(pgrep -f "auto-mobile.*--daemon-mode" 2>/dev/null || true)
      if [[ -n "${pids}" ]]; then
        echo "${pids}" | xargs kill -9 2>/dev/null || true
      fi
    else
      # Check exit status of completed process
      local exit_status=0
      wait "${daemon_pid}" || exit_status=$?
      if [[ ${exit_status} -eq 0 ]]; then
        log_info "MCP daemon restarted."
      else
        log_warn "Daemon restart failed (exit ${exit_status}). See ${daemon_log}"
      fi
    fi
  else
    local pids
    pids=$(pgrep -f "auto-mobile.*--daemon-mode" 2>/dev/null || true)
    if [[ -n "${pids}" ]]; then
      log_info "Killing daemon processes: ${pids}"
      echo "${pids}" | xargs kill 2>/dev/null || true
      sleep 1
      # Force kill if still running
      pids=$(pgrep -f "auto-mobile.*--daemon-mode" 2>/dev/null || true)
      if [[ -n "${pids}" ]]; then
        log_warn "Force killing daemon processes..."
        echo "${pids}" | xargs kill -9 2>/dev/null || true
      fi
    fi
  fi
}

# List TypeScript source files to watch
list_ts_files() {
  local src_dir="${PROJECT_ROOT}/src"
  if [[ -d "${src_dir}" ]]; then
    find "${src_dir}" -type f -name "*.ts" 2>/dev/null || true
  fi
}

# Compute hash of TypeScript file timestamps
hash_ts_state() {
  list_ts_files | while read -r file; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}

# Build TypeScript
build_typescript() {
  log_info "Building TypeScript..."
  if (cd "${PROJECT_ROOT}" && bunx turbo run build --output-logs=errors-only); then
    log_info "TypeScript build complete."
    return 0
  else
    log_warn "TypeScript build failed."
    return 1
  fi
}

# iOS-specific file list (separate from APK file list)
list_ios_watch_files() {
  local watch_dirs=(
    "${CTRL_PROXY_IOS_DIR}/Sources"
    "${CTRL_PROXY_IOS_DIR}/Tests"
    "${CTRL_PROXY_IOS_DIR}/CtrlProxyApp"
  )
  local extra_files=(
    "${CTRL_PROXY_IOS_DIR}/project.yml"
    "${CTRL_PROXY_IOS_DIR}/CtrlProxy.xcodeproj/project.pbxproj"
  )

  if command -v rg >/dev/null 2>&1; then
    rg --files "${watch_dirs[@]}" -g '!**/build/**' 2>/dev/null || true
  else
    find "${watch_dirs[@]}" -type f ! -path "*/build/*" 2>/dev/null || true
  fi

  for file in "${extra_files[@]}"; do
    if [[ -f "${file}" ]]; then
      echo "${file}"
    fi
  done
}

# iOS-specific hash (separate from APK hash)
hash_ios_watch_state() {
  list_ios_watch_files | while read -r file; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}

# APK-specific file list (renamed from hash_watch_state collision)
list_apk_watch_files() {
  local watch_dirs=(
    "${SERVICE_DIR}"
    "${ANDROID_DIR}/auto-mobile-sdk"
  )
  local extra_files=(
    "${ANDROID_DIR}/build.gradle.kts"
    "${ANDROID_DIR}/settings.gradle.kts"
    "${ANDROID_DIR}/gradle.properties"
  )

  if command -v rg >/dev/null 2>&1; then
    rg --files "${watch_dirs[@]}" -g '!**/build/**' 2>/dev/null || true
  else
    find "${watch_dirs[@]}" -type f ! -path "*/build/*" 2>/dev/null || true
  fi

  for file in "${extra_files[@]}"; do
    if [[ -f "${file}" ]]; then
      echo "${file}"
    fi
  done
}

# APK-specific hash (renamed from hash_watch_state collision)
hash_apk_watch_state() {
  list_apk_watch_files | while read -r file; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}

# Android video-server-specific file list
list_video_server_watch_files() {
  local watch_dirs=(
    "${VIDEO_SERVER_DIR}"
  )
  local extra_files=(
    "${ANDROID_DIR}/build.gradle.kts"
    "${ANDROID_DIR}/settings.gradle.kts"
    "${ANDROID_DIR}/gradle.properties"
  )

  if command -v rg >/dev/null 2>&1; then
    rg --files "${watch_dirs[@]}" -g '!**/build/**' 2>/dev/null || true
  else
    find "${watch_dirs[@]}" -type f ! -path "*/build/*" 2>/dev/null || true
  fi

  for file in "${extra_files[@]}"; do
    if [[ -f "${file}" ]]; then
      echo "${file}"
    fi
  done
}

# Android video-server-specific hash
hash_video_server_watch_state() {
  list_video_server_watch_files | while read -r file; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}

# Build Android video server DEX jar used by the preferred WebRTC path
build_video_server() {
  log_info "Building Android video server..."
  if ! (cd "${ANDROID_DIR}" && ./gradlew :video-server:d8Dex); then
    log_error "Android video server build failed."
    return 1
  fi

  if [[ ! -f "${VIDEO_SERVER_JAR_PATH}" ]]; then
    log_error "Video server jar not found at ${VIDEO_SERVER_JAR_PATH}"
    return 1
  fi

  return 0
}

# Push Android video server jar to a specific device
install_video_server_to_device() {
  local device="$1"
  log_info "Pushing Android video server to ${device}..."
  if ! "${ADB_BIN}" -s "${device}" push "${VIDEO_SERVER_JAR_PATH}" "${VIDEO_SERVER_REMOTE_JAR_PATH}"; then
    log_warn "ADB push failed for Android video server on ${device}."
    return 1
  fi
  log_info "Android video server pushed to ${device}."
  return 0
}

# Push Android video server jar to target device(s)
install_video_server() {
  if [[ ! -f "${VIDEO_SERVER_JAR_PATH}" ]]; then
    log_warn "Android video server jar missing. Skipping push."
    return 1
  fi

  if [[ -n "${DEVICE_ID}" ]]; then
    install_video_server_to_device "${DEVICE_ID}"
    return $?
  fi

  local devices
  devices=$(get_connected_devices)
  if [[ -z "${devices}" ]]; then
    log_warn "No devices connected. Skipping Android video server push."
    return 1
  fi

  local success=0
  local fail=0
  local install_status=0
  while IFS= read -r device; do
    set +e
    install_video_server_to_device "${device}"
    install_status=$?
    set -e
    if [[ ${install_status} -eq 0 ]]; then
      success=$((success + 1))
    else
      fail=$((fail + 1))
    fi
  done <<< "${devices}"

  log_info "Android video server push complete: ${success} succeeded, ${fail} failed."
  [[ ${fail} -eq 0 && ${success} -gt 0 ]]
}

# Setup desktop app
setup_desktop_app() {
  log_info "Building desktop app (desktop-core + desktop-app)..."
  if ! build_desktop_app; then
    log_error "Desktop app build failed. Fix errors and retry."
    return 1
  fi
  return 0
}

# Setup Android
setup_android() {
  resolve_adb

  if resolve_device; then
    HAVE_DEVICE=true
  fi

  if [[ -n "${DEVICE_ID}" ]]; then
    log_info "Target device: ${DEVICE_ID}"
  elif [[ "${HAVE_DEVICE}" == "true" ]]; then
    log_info "Target: all connected devices"
  else
    log_info "Target: no devices (will install when available)"
  fi

  log_info "APK path: ${APK_PATH}"
  log_info "Building AccessibilityService..."

  if ! build_apk; then
    log_error "Initial APK build failed. Fix errors and retry."
    return 1
  fi

  local video_server_built=false
  local video_server_status=0
  set +e
  build_video_server
  video_server_status=$?
  set -e
  if [[ ${video_server_status} -eq 0 ]]; then
    video_server_built=true
    ANDROID_VIDEO_SERVER_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=true
  else
    log_warn "Initial Android video server build failed. Continuing with APK hot-reload; WebRTC will fall back to screenrecord until the jar builds."
  fi

  # Update SHA after successful build (regardless of device availability)
  local checksum
  checksum="$(compute_checksum)"
  if [[ -n "${checksum}" ]]; then
    log_info "APK sha256: ${checksum}"
    update_checksum "${checksum}"
  fi

  if [[ "${HAVE_DEVICE}" == "true" ]]; then
    if ! install_apk; then
      log_warn "Initial install failed. Will retry when devices connect."
    fi
    if [[ "${video_server_built}" == "true" ]]; then
      set +e
      install_video_server
      video_server_status=$?
      set -e
      if [[ ${video_server_status} -ne 0 ]]; then
        VIDEO_SERVER_NEEDS_INSTALL=true
        log_warn "Initial Android video server push failed. Will retry when devices connect."
      fi
    fi
  else
    if [[ "${video_server_built}" == "true" ]]; then
      log_info "No devices connected. APK and Android video server built and ready for install."
    else
      log_info "No devices connected. APK built and ready for install."
    fi
  fi

  return 0
}

# Setup iOS
setup_ios() {
  if ! command -v xcodebuild >/dev/null 2>&1; then
    log_warn "xcodebuild not found. Skipping iOS setup."
    return 1
  fi

  if [[ ! -d "${CTRL_PROXY_IOS_DIR}" ]]; then
    log_warn "CtrlProxy iOS directory not found: ${CTRL_PROXY_IOS_DIR}"
    return 1
  fi

  if [[ -n "${SIMULATOR_ID}" ]]; then
    export SIMULATOR_ID_OVERRIDE="${SIMULATOR_ID}"
    log_info "Target simulator: ${SIMULATOR_ID} (must be booted)"
  else
    log_info "Target: booted simulator (will start service when available)"
  fi

  log_info "Derived data: ${DERIVED_DATA_PATH}"
  log_info "Building CtrlProxy iOS..."

  if ! build_ctrl_proxy_ios; then
    log_warn "Initial CtrlProxy iOS build failed. Will retry on changes."
    return 1
  fi

  if [[ "${RUN_ONCE}" != "true" ]] && [[ "${MANAGE_IOS_RUNNER}" != "true" ]]; then
    IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=true
  fi

  return 0
}

# Get current booted simulator
get_current_simulator() {
  if [[ -n "${SIMULATOR_ID_OVERRIDE:-}" ]]; then
    if xcrun simctl list devices booted -j 2>/dev/null | \
      grep -q "\"${SIMULATOR_ID_OVERRIDE}\""; then
      echo "${SIMULATOR_ID_OVERRIDE}"
    fi
  else
    xcrun simctl list devices booted -j 2>/dev/null | \
      grep -o '"udid" : "[^"]*"' | head -1 | sed 's/"udid" : "//;s/"$//'
  fi
}

# Unified watch loop
unified_watch_loop() {
  local poll_interval="${1:-2}"

  log_info "Starting unified watch loop (poll interval ${poll_interval}s)..."
  log_info "Watching: Desktop app=$(bool_str ${DESKTOP_APP_ENABLED}), Android=$(bool_str ${ANDROID_ENABLED}), iOS=$(bool_str ${IOS_ENABLED}), TypeScript=true"
  if [[ "${IOS_ENABLED}" == "true" ]]; then
    if [[ "${MANAGE_IOS_RUNNER}" == "true" ]]; then
      log_info "iOS CtrlProxy runner owner: watcher (--manage-ios-runner)"
    else
      log_info "iOS CtrlProxy runner owner: MCP daemon (watcher only rebuilds + reloads daemon)"
    fi
  fi

  # Initialize hashes (desktop app self-reloads via Compose Hot Reload; no hash)
  if [[ "${ANDROID_ENABLED}" == "true" ]]; then
    LAST_APK_HASH="$(hash_apk_watch_state)"
    LAST_VIDEO_SERVER_HASH="$(hash_video_server_watch_state)"
  fi
  if [[ "${IOS_ENABLED}" == "true" ]]; then
    LAST_IOS_HASH="$(hash_ios_watch_state)"
  fi
  LAST_TS_HASH="$(hash_ts_state)"

  # Initialize device state
  if [[ "${ANDROID_ENABLED}" == "true" ]]; then
    LAST_ADB_DEVICES=$(get_connected_devices | sort | tr '\n' ' ')
  fi
  if [[ "${IOS_ENABLED}" == "true" ]]; then
    LAST_SIMULATOR="$(get_current_simulator)"
  fi

  while true; do
    sleep "${poll_interval}"

    # Check timeout if running with a deadline
    if [[ -n "${WATCHER_START_TIME:-}" ]] && [[ -n "${MAX_DURATION:-}" ]]; then
      local elapsed=$(( $(date +%s) - WATCHER_START_TIME ))
      if [[ ${elapsed} -ge ${MAX_DURATION} ]]; then
        log_info "Hot-reload timeout reached (${TIMEOUT_MINUTES:-60} minutes). Stopping."
        return 0
      fi
    fi

    # === 1. Desktop app ===
    # The desktop app runs under Compose Hot Reload (`hotRun --autoReload`), which
    # owns a Gradle daemon that recompiles desktop-core/desktop-app edits and
    # reloads them into the SAME window. So the watcher must NOT rebuild/restart on
    # source change — doing so would kill the live-reload process for every keystroke
    # and reintroduce the rebuild-under-JVM NoClassDefFoundError trap. We only relaunch
    # if the app process has died (e.g. crashed or the reload daemon exited), with
    # bounded exponential backoff so an immediately-exiting hotRun cannot spin.
    if [[ "${DESKTOP_APP_ENABLED}" == "true" ]]; then
      local desktop_pid now_ts
      desktop_pid="$(cat "${DESKTOP_APP_PID_FILE}" 2>/dev/null || true)"
      now_ts=$(date +%s)
      if [[ -n "${desktop_pid}" ]] && kill -0 "${desktop_pid}" 2>/dev/null; then
        # Alive — clear backoff only once it has stayed up long enough to be healthy.
        # A crash-looping launcher is briefly "alive" between relaunches while Gradle
        # spins up, so resetting on the first live poll would defeat the backoff.
        if [[ ${DESKTOP_RELAUNCH_ATTEMPTS} -gt 0 ]] &&
          [[ $(( now_ts - DESKTOP_LAST_LAUNCH_TS )) -ge ${DESKTOP_RELAUNCH_STABLE_SECS} ]]; then
          log_info "[Desktop App] Stable again; clearing relaunch backoff."
          DESKTOP_RELAUNCH_ATTEMPTS=0
          DESKTOP_RELAUNCH_NEXT_TS=0
        fi
      elif [[ ${DESKTOP_RELAUNCH_ATTEMPTS} -ge ${DESKTOP_RELAUNCH_MAX} ]]; then
        : # Gave up after DESKTOP_RELAUNCH_MAX attempts; stay quiet until it recovers.
      elif [[ ${now_ts} -ge ${DESKTOP_RELAUNCH_NEXT_TS} ]]; then
        DESKTOP_RELAUNCH_ATTEMPTS=$(( DESKTOP_RELAUNCH_ATTEMPTS + 1 ))
        local backoff=$(( POLL_INTERVAL * (1 << (DESKTOP_RELAUNCH_ATTEMPTS - 1)) ))
        [[ ${backoff} -gt ${DESKTOP_RELAUNCH_BACKOFF_CAP} ]] && backoff=${DESKTOP_RELAUNCH_BACKOFF_CAP}
        DESKTOP_RELAUNCH_NEXT_TS=$(( now_ts + backoff ))
        DESKTOP_LAST_LAUNCH_TS=${now_ts}
        if [[ ${DESKTOP_RELAUNCH_ATTEMPTS} -ge ${DESKTOP_RELAUNCH_MAX} ]]; then
          log_warn "[Desktop App] Not running; final relaunch (${DESKTOP_RELAUNCH_ATTEMPTS}/${DESKTOP_RELAUNCH_MAX}). If it keeps exiting, see ${DESKTOP_APP_LOG}."
        else
          log_warn "[Desktop App] Process not running; relaunching (${DESKTOP_RELAUNCH_ATTEMPTS}/${DESKTOP_RELAUNCH_MAX}, next retry in >=${backoff}s)."
        fi
        # Preserve the log so a repeatedly-crashing hotRun keeps its diagnostics.
        run_desktop_app preserve_log
      fi
    fi

    # === 2. Check Android changes ===
    if [[ "${ANDROID_ENABLED}" == "true" ]]; then
      # Check device list changes
      local current_devices
      current_devices=$(get_connected_devices | sort | tr '\n' ' ')
      local devices_changed=false

      if [[ "${current_devices}" != "${LAST_ADB_DEVICES}" ]]; then
        devices_changed=true
        if [[ -n "${current_devices}" ]] && [[ -z "${LAST_ADB_DEVICES}" ]]; then
          log_info "[Android] Device(s) connected: ${current_devices}"
        elif [[ -z "${current_devices}" ]] && [[ -n "${LAST_ADB_DEVICES}" ]]; then
          log_info "[Android] All devices disconnected."
        elif [[ -n "${current_devices}" ]]; then
          log_info "[Android] Device list changed: ${current_devices}"
        fi
        LAST_ADB_DEVICES="${current_devices}"
      fi

      # Check file changes
      local next_apk_hash
      next_apk_hash="$(hash_apk_watch_state)"
      local apk_files_changed=false

      if [[ "${next_apk_hash}" != "${LAST_APK_HASH}" ]]; then
        apk_files_changed=true
        LAST_APK_HASH="${next_apk_hash}"
      fi

      local next_video_server_hash
      next_video_server_hash="$(hash_video_server_watch_state)"
      local video_server_files_changed=false

      if [[ "${next_video_server_hash}" != "${LAST_VIDEO_SERVER_HASH}" ]]; then
        video_server_files_changed=true
        LAST_VIDEO_SERVER_HASH="${next_video_server_hash}"
      fi

      # Rebuild APK if files changed
      if [[ "${apk_files_changed}" == "true" ]]; then
        log_info "[Android] Change detected. Rebuilding..."
        if build_apk; then
          APK_NEEDS_INSTALL=true
          LAST_APK_HASH="$(hash_apk_watch_state)"
          # Update SHA after successful build (regardless of device availability)
          local checksum
          checksum="$(compute_checksum)"
          if [[ -n "${checksum}" ]]; then
            log_info "[Android] APK sha256: ${checksum}"
            update_checksum "${checksum}"
          fi
        else
          log_warn "[Android] Build failed; waiting for next change."
        fi
      fi

      # Rebuild video server if files changed
      if [[ "${video_server_files_changed}" == "true" ]]; then
        log_info "[Android Video] Change detected. Rebuilding..."
        local video_server_status=0
        set +e
        build_video_server
        video_server_status=$?
        set -e
        if [[ ${video_server_status} -eq 0 ]]; then
          VIDEO_SERVER_NEEDS_INSTALL=true
          LAST_VIDEO_SERVER_HASH="$(hash_video_server_watch_state)"
          reload_mcp_daemon false
        else
          log_warn "[Android Video] Build failed; waiting for next change."
        fi
      fi

      # Install if pending and devices available
      if [[ "${APK_NEEDS_INSTALL}" == "true" ]] || [[ "${devices_changed}" == "true" ]]; then
        if [[ -n "${current_devices}" ]] && [[ -f "${APK_PATH}" ]]; then
          if install_apk; then
            APK_NEEDS_INSTALL=false
            log_info "[Android] APK installed to device(s)."
          else
            log_warn "[Android] Install failed; will retry."
          fi
        fi
      fi

      # Push video server if pending and devices available
      if [[ "${VIDEO_SERVER_NEEDS_INSTALL}" == "true" ]] || [[ "${devices_changed}" == "true" ]]; then
        if [[ -n "${current_devices}" ]] && [[ -f "${VIDEO_SERVER_JAR_PATH}" ]]; then
          local video_server_status=0
          set +e
          install_video_server
          video_server_status=$?
          set -e
          if [[ ${video_server_status} -eq 0 ]]; then
            VIDEO_SERVER_NEEDS_INSTALL=false
            log_info "[Android Video] Video server pushed to device(s)."
          else
            VIDEO_SERVER_NEEDS_INSTALL=true
            log_warn "[Android Video] Push failed; will retry."
          fi
        fi
      fi
    fi

    # === 3. Check iOS changes ===
    if [[ "${IOS_ENABLED}" == "true" ]]; then
      local ios_daemon_reload_needed=false

      # Check simulator state
      local current_simulator
      current_simulator="$(get_current_simulator)"

      if [[ "${current_simulator}" != "${LAST_SIMULATOR}" ]]; then
        if [[ -n "${current_simulator}" ]]; then
          if [[ "${MANAGE_IOS_RUNNER}" == "true" ]] && [[ "${current_simulator}" != "${CTRL_PROXY_SIMULATOR}" ]]; then
            # Genuinely new/different simulator; restart CtrlProxy for it.
            log_info "[iOS] New booted simulator: ${current_simulator}"
            IOS_NEEDS_RESTART=true
          elif [[ "${MANAGE_IOS_RUNNER}" != "true" ]]; then
            log_info "[iOS] Booted simulator changed: ${current_simulator}; reloading daemon-owned CtrlProxy runner."
            ios_daemon_reload_needed=true
          else
            # Same simulator CtrlProxy is already targeting (reappeared after xcodebuild reboot)
            log_info "[iOS] Simulator returned: ${current_simulator}"
          fi
        else
          log_warn "[iOS] No booted simulator detected."
        fi
        LAST_SIMULATOR="${current_simulator}"
      fi

      # Check file changes
      local next_ios_hash
      next_ios_hash="$(hash_ios_watch_state)"

      if [[ "${next_ios_hash}" != "${LAST_IOS_HASH}" ]]; then
        log_info "[iOS] Change detected. Rebuilding..."
        if build_ctrl_proxy_ios; then
          LAST_IOS_HASH="$(hash_ios_watch_state)"
          IOS_NEEDS_RESTART=true
          # Update TypeScript checksum after iOS build
          local ios_checksum
          ios_checksum="$(get_xctestrun_path | hash_stream)"
          if [[ -n "${ios_checksum}" ]]; then
            log_info "[iOS] Build hash: ${ios_checksum:0:16}..."
          fi
          # When the daemon owns the runner, a fresh build only takes effect
          # after the daemon relaunches it. Reload the daemon so it picks up the
          # new CtrlProxy iOS build without the watcher touching the runner.
          if [[ "${MANAGE_IOS_RUNNER}" != "true" ]]; then
            log_info "[iOS] Daemon owns the runner; scheduling daemon reload to pick up the new build."
            ios_daemon_reload_needed=true
            IOS_NEEDS_RESTART=false
          fi
        else
          log_warn "[iOS] Build failed; waiting for next change."
        fi
      fi

      if [[ "${MANAGE_IOS_RUNNER}" != "true" ]] && [[ "${ios_daemon_reload_needed}" == "true" ]]; then
        reload_mcp_daemon true
      fi

      # Runner lifecycle is only managed here when explicitly requested via
      # --manage-ios-runner. By default the MCP daemon's ensureCtrlProxy solely
      # owns the CtrlProxy iOS runner, so starting/stopping/restarting it from
      # the watcher would race the daemon on port 8765.
      if [[ "${MANAGE_IOS_RUNNER}" == "true" ]]; then
        # Check if CtrlProxy iOS process died
        if [[ -n "${XCODEBUILD_PID}" ]] && ! kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
          log_warn "[iOS] CtrlProxy iOS process exited."
          XCODEBUILD_PID=""
          CTRL_PROXY_SIMULATOR=""
          IOS_NEEDS_RESTART=true
        fi

        # Restart if needed
        if [[ "${IOS_NEEDS_RESTART}" == "true" ]] && [[ -n "${LAST_SIMULATOR}" ]]; then
          stop_ctrl_proxy_ios
          start_ctrl_proxy_ios "${LAST_SIMULATOR}"
          CTRL_PROXY_SIMULATOR="${LAST_SIMULATOR}"
          IOS_NEEDS_RESTART=false
        fi
      fi
    fi

    # === 4. Check TypeScript changes ===
    local next_ts_hash
    next_ts_hash="$(hash_ts_state)"
    if [[ "${next_ts_hash}" != "${LAST_TS_HASH}" ]]; then
      log_info "[TypeScript] Change detected. Rebuilding and reloading MCP daemon..."
      if build_typescript; then
        reload_mcp_daemon
      fi
      LAST_TS_HASH="${next_ts_hash}"
    fi
  done
}

# Helper for boolean display
bool_str() {
  if [[ "$1" == "true" ]]; then
    echo "yes"
  else
    echo "no"
  fi
}

# Cleanup on foreground exit (only removes PID file if we fail before backgrounding)
cleanup() {
  rm -f "${PID_FILE}"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      if [[ $# -lt 2 ]]; then
        log_error "--device requires a value."
        usage
        exit 1
      fi
      DEVICE_ID="$2"
      shift 2
      ;;
    --simulator)
      if [[ $# -lt 2 ]]; then
        log_error "--simulator requires a value."
        usage
        exit 1
      fi
      SIMULATOR_ID="$2"
      shift 2
      ;;
    --once)
      RUN_ONCE=true
      shift
      ;;
    --poll-interval)
      if [[ $# -lt 2 ]]; then
        log_error "--poll-interval requires a value."
        usage
        exit 1
      fi
      POLL_INTERVAL="$2"
      shift 2
      ;;
    --timeout)
      if [[ $# -lt 2 ]]; then
        log_error "--timeout requires a value."
        usage
        exit 1
      fi
      TIMEOUT_MINUTES="$2"
      shift 2
      ;;
    --manage-ios-runner)
      MANAGE_IOS_RUNNER=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# Set up cleanup trap
trap cleanup EXIT INT TERM

# Ensure scratch directory exists
mkdir -p "${PROJECT_ROOT}/scratch"

# Check and install dependencies
if ! ensure_dependencies; then
  log_error "Dependency check failed. Exiting."
  exit 1
fi

log_info "=== AutoMobile Unified Hot-Reload ==="

# Setup desktop app
if setup_desktop_app; then
  DESKTOP_APP_ENABLED=true
  log_info "Desktop app setup complete."
else
  log_warn "Desktop app setup failed. Continuing without desktop app hot-reload."
fi

# Setup Android
if setup_android; then
  ANDROID_ENABLED=true
  log_info "Android setup complete."
else
  log_warn "Android setup failed. Continuing without Android hot-reload."
fi

# Setup iOS
if setup_ios; then
  IOS_ENABLED=true
  log_info "iOS setup complete."
else
  log_warn "iOS setup failed. Continuing without iOS hot-reload."
fi

# Handle --once mode
if [[ "${RUN_ONCE}" == "true" ]]; then
  log_info "Run-once mode complete."
  if [[ "${DESKTOP_APP_ENABLED}" == "true" ]]; then
    run_desktop_app
  fi
  exit 0
fi

# Kill previous background watchers
kill_previous

if [[ "${ANDROID_VIDEO_SERVER_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF}" == "true" ]] || \
  [[ "${IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF}" == "true" ]]; then
  if [[ "${ANDROID_VIDEO_SERVER_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF}" == "true" ]]; then
    log_info "Initial Android video server build complete; reloading daemon after previous watcher cleanup."
  fi
  if [[ "${IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF}" == "true" ]]; then
    log_info "Initial iOS build complete; reloading daemon after previous watcher cleanup."
  fi
  if [[ "${IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF}" == "true" ]]; then
    reload_mcp_daemon true
  else
    reload_mcp_daemon false
  fi
  ANDROID_VIDEO_SERVER_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=false
  IOS_NEEDS_DAEMON_RELOAD_AFTER_HANDOFF=false
fi

# Change to project root
cd "${PROJECT_ROOT}"

# Launch desktop app for initial run (foreground, before backgrounding watcher)
if [[ "${DESKTOP_APP_ENABLED}" == "true" ]]; then
  run_desktop_app
fi

# Launch background watcher
WATCHER_LOG="${PROJECT_ROOT}/scratch/hot-reload.log"
: > "${WATCHER_LOG}"

(
  # Background watcher cleanup: stops CtrlProxy iOS and removes PID file
  # shellcheck disable=SC2317,SC2329 # invoked indirectly via trap
  watcher_cleanup() {
    log_info "Watcher stopping..."
    stop_desktop_app
    # Only stop the CtrlProxy iOS runner if the watcher owns it. When the daemon
    # owns it (default), stopping here would kill the daemon's runner.
    if [[ "${MANAGE_IOS_RUNNER}" == "true" ]]; then
      stop_ctrl_proxy_ios
    fi
    rm -f "${PID_FILE}"
  }
  trap watcher_cleanup EXIT TERM INT HUP

  WATCHER_START_TIME=$(date +%s)
  MAX_DURATION=$(( TIMEOUT_MINUTES * 60 ))

  # Start initial iOS CtrlProxy only when the watcher owns the runner. By
  # default the MCP daemon owns it, so we just record the current simulator for
  # change detection and leave the runner to the daemon.
  if [[ "${IOS_ENABLED}" == "true" ]]; then
    initial_simulator="$(get_current_simulator)"
    if [[ -n "${initial_simulator}" ]]; then
      LAST_SIMULATOR="${initial_simulator}"
      if [[ "${MANAGE_IOS_RUNNER}" == "true" ]]; then
        start_ctrl_proxy_ios "${initial_simulator}"
        CTRL_PROXY_SIMULATOR="${initial_simulator}"
      else
        log_info "[iOS] Daemon owns the CtrlProxy runner; watcher will not start it."
      fi
    fi
  fi

  unified_watch_loop "${POLL_INTERVAL}"
) >> "${WATCHER_LOG}" 2>&1 &

WATCHER_PID=$!
echo "${WATCHER_PID}" > "${PID_FILE}"
disown "${WATCHER_PID}"

# Clear the foreground trap; PID file now belongs to the background watcher
trap - EXIT INT TERM

log_info "Hot-reload watcher running in background (PID ${WATCHER_PID})."
log_info "Auto-stops after ${TIMEOUT_MINUTES} minutes. Re-run to restart."
log_info "Watch logs: tail -f ${WATCHER_LOG}"
