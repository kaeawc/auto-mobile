#!/usr/bin/env bash
#
# IDE plugin build, install, and watch utilities for local development.
# Now targets the desktop-app module (Compose Desktop) instead of the
# IntelliJ plugin, so there is no IDE restart dance.
#
# Required variables (must be set before sourcing):
#   PROJECT_ROOT - Path to project root
#
# Functions:
#   build_desktop_app()               - Run gradlew :desktop-app:build -x test
#   run_desktop_app()                 - Launch desktop-app via gradlew :desktop-app:hotRun --autoReload
#   stop_desktop_app()                - Kill running desktop-app process (launcher + hot-reload JVM)
#   hash_desktop_gradle_state()       - Hash of the two desktop build.gradle.kts (restart-on-config)

# Desktop app paths
ANDROID_DIR="${PROJECT_ROOT}/android"

# Runtime state
DESKTOP_APP_PID=""
DESKTOP_APP_PID_FILE="${PROJECT_ROOT}/.automobile-desktop-app.pid"
DESKTOP_APP_LOG="${PROJECT_ROOT}/scratch/desktop-app.log"

# Build the desktop app (compile only, no tests)
build_desktop_app() {
  log_info "Building desktop app..."
  if (cd "${ANDROID_DIR}" && ./gradlew :desktop-app:build -x test --quiet); then
    log_info "Desktop app build complete."
    return 0
  else
    log_warn "Desktop app build failed."
    return 1
  fi
}

# Alias for backwards-compat with hot-reload.sh
build_ide_plugin() {
  build_desktop_app
}

# Install is a no-op for desktop app (no IDE plugin zip to copy)
install_ide_plugin() {
  return 0
}

# Launch the desktop app in the background via Compose Hot Reload, logging to a file.
#
# `hotRun --autoReload` launches a separate Gradle daemon that continuously
# recompiles and reloads desktop-core/desktop-app source into the SAME running
# window — no rebuild-and-restart cycle. This avoids the plain `:desktop-app:run`
# trap where a rebuild overwrites the running JVM's exploded classes and the next
# lazy class load throws NoClassDefFoundError. Because Compose Hot Reload owns
# desktop reloading, the unified watcher must NOT also rebuild/restart the app on
# desktop source changes (see hot-reload.sh). `--no-configuration-cache` is
# required: the hot-reload tasks are not configuration-cache serializable and the
# repo enables the configuration cache by default.
# Pass "preserve_log" as $1 to append to the existing log instead of truncating it
# (used by the watcher's crash-relaunch path so a hotRun that exits immediately does
# not erase its own diagnostics on every retry).
run_desktop_app() {
  local preserve_log="${1:-}"
  stop_desktop_app
  mkdir -p "$(dirname "${DESKTOP_APP_LOG}")"
  if [[ "${preserve_log}" != "preserve_log" ]]; then
    : > "${DESKTOP_APP_LOG}"
  fi
  log_info "Launching desktop app (Compose Hot Reload, --autoReload)..."
  (cd "${ANDROID_DIR}" && ./gradlew :desktop-app:hotRun --autoReload --no-configuration-cache --quiet) \
    >> "${DESKTOP_APP_LOG}" 2>&1 &
  DESKTOP_APP_PID=$!
  echo "${DESKTOP_APP_PID}" > "${DESKTOP_APP_PID_FILE}"
  disown "${DESKTOP_APP_PID}"
  log_info "Desktop app running (PID ${DESKTOP_APP_PID}); source edits reload live."
  log_info "Desktop app logs: tail -f ${DESKTOP_APP_LOG}"
}

# Stop the running desktop app
stop_desktop_app() {
  # Recover PID from file if not set in memory (e.g. different process)
  if [[ -z "${DESKTOP_APP_PID}" ]] && [[ -f "${DESKTOP_APP_PID_FILE}" ]]; then
    DESKTOP_APP_PID=$(cat "${DESKTOP_APP_PID_FILE}" 2>/dev/null || true)
  fi
  if [[ -n "${DESKTOP_APP_PID}" ]] && kill -0 "${DESKTOP_APP_PID}" 2>/dev/null; then
    log_info "Stopping desktop app (PID ${DESKTOP_APP_PID})..."
    kill "${DESKTOP_APP_PID}" 2>/dev/null || true
    local count=0
    while kill -0 "${DESKTOP_APP_PID}" 2>/dev/null && [[ ${count} -lt 5 ]]; do
      sleep 1
      count=$((count + 1))
    done
    if kill -0 "${DESKTOP_APP_PID}" 2>/dev/null; then
      kill -9 "${DESKTOP_APP_PID}" 2>/dev/null || true
    fi
    DESKTOP_APP_PID=""
  fi
  rm -f "${DESKTOP_APP_PID_FILE}"
  # Also kill any orphaned desktop-app Gradle processes: the launcher (hotRun/run),
  # the Compose Hot Reload JVM (identified by its -Dcompose.reload.argfile), and the
  # app main class. Every one of these carries THIS checkout's ${ANDROID_DIR} in its
  # argv (Gradle wrapper classpath, the reload argfile path, or the app classpath), so
  # every pattern is scoped to that path. Never match machine-wide: another workspace
  # or checkout hot-reloading under the same account has an identical bare
  # `compose.reload.argfile` / `MainKt` command line, and an unscoped pgrep would kill
  # its JVM too.
  #
  # `pgrep -f` treats its pattern as an extended regex, so the interpolated path must
  # be escaped: an unescaped `.` would match any char (broadening into another
  # checkout), and a literal `+`/`(`/`)` in the path would fail to match its own
  # process. Escape every ERE metacharacter in ${ANDROID_DIR} to a literal.
  local android_re
  android_re=$(printf '%s' "${ANDROID_DIR}" | sed 's/[][(){}.^$*+?|\\]/\\&/g')
  local pids
  pids=$(
    pgrep -f "${android_re}.*:desktop-app:hotRun" 2>/dev/null
    pgrep -f "${android_re}.*:desktop-app:run" 2>/dev/null
    pgrep -f "compose\\.reload\\.argfile=${android_re}" 2>/dev/null
    pgrep -f "${android_re}.*dev\\.jasonpearson\\.automobile\\.desktop\\.MainKt" 2>/dev/null
  ) || true
  if [[ -n "${pids}" ]]; then
    echo "${pids}" | xargs kill 2>/dev/null || true
  fi
}

# Desktop app SOURCE edits are handled by Compose Hot Reload (hotRun --autoReload),
# so the watcher does not diff source hashes. The two Gradle BUILD SCRIPTS are the
# exception: Compose Hot Reload reloads source into the running window but does not
# reconfigure an already-created Gradle project model, so a change to a build script
# (new dependency, plugin, or compiler option) needs a full desktop-app restart or
# later compilation runs against stale configuration. The watcher hashes just these
# two files and restarts on change (see hot-reload.sh).
DESKTOP_GRADLE_BUILD_FILES=(
  "${ANDROID_DIR}/desktop-core/build.gradle.kts"
  "${ANDROID_DIR}/desktop-app/build.gradle.kts"
)

# Hash of the desktop Gradle build scripts' timestamps (for restart-on-config-change)
hash_desktop_gradle_state() {
  local file
  for file in "${DESKTOP_GRADLE_BUILD_FILES[@]}"; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}
