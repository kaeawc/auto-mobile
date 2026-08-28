#!/usr/bin/env bash
#
# CtrlProxy iOS build, run, and watch utilities for local development.
#
# Required variables (must be set before sourcing):
#   PROJECT_ROOT        - Path to project root
#   CTRL_PROXY_IOS_DIR  - Path to ios/control-proxy directory
#   DERIVED_DATA_PATH   - Path to derived data for CtrlProxy
#
# Functions:
#   hash_stream()              - Compute SHA256 hash from stdin
#   stat_entry()               - Get file modification time (portable)
#   list_watch_files()         - List CtrlProxy iOS source files to watch
#   hash_watch_state()         - Hash of all watched file timestamps
#   needs_project_generation() - Check if xcodegen should run
#   run_xcodegen()             - Generate Xcode project with xcodegen
#   build_ctrl_proxy_ios()      - Build CtrlProxy iOS for testing
#   get_xctestrun_path()       - Find the .xctestrun file in derived data
#   start_ctrl_proxy_ios()      - Start CtrlProxy iOS on a simulator
#   stop_ctrl_proxy_ios()       - Stop the running CtrlProxy iOS process
#   watch_loop()               - Watch for changes and rebuild/restart

# Runtime state
XCODEBUILD_PID=""
XCODEBUILD_LOG=""
IOS_RUNNER_PID_FILE="${IOS_RUNNER_PID_FILE:-${PROJECT_ROOT}/scratch/ios-ctrl-proxy-runner.pid}"

# Compute SHA256 hash from stdin
hash_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | awk '{print $2}'
    return
  fi

  log_error "No SHA256 tool available (sha256sum, shasum, or openssl)."
  exit 1
}

# Get file modification time (portable between macOS and Linux)
stat_entry() {
  local file="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f "%m %N" "${file}"
  else
    stat -c "%Y %n" "${file}"
  fi
}

# List all files to watch for changes
list_watch_files() {
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
    rg --files "${watch_dirs[@]}" -g '!**/build/**'
  else
    find "${watch_dirs[@]}" -type f ! -path "*/build/*"
  fi

  for file in "${extra_files[@]}"; do
    if [[ -f "${file}" ]]; then
      echo "${file}"
    fi
  done
}

# Compute hash of all watched file timestamps
hash_watch_state() {
  list_watch_files | while read -r file; do
    if [[ -f "${file}" ]]; then
      stat_entry "${file}" 2>/dev/null || true
    fi
  done | sort | hash_stream
}

# Check if project.yml is newer than xcodeproj
needs_project_generation() {
  local project_yml="${CTRL_PROXY_IOS_DIR}/project.yml"
  local xcodeproj="${CTRL_PROXY_IOS_DIR}/CtrlProxy.xcodeproj/project.pbxproj"

  if [[ ! -f "${project_yml}" ]]; then
    return 1
  fi

  if [[ ! -f "${xcodeproj}" ]]; then
    return 0
  fi

  local yml_mtime
  local proj_mtime
  yml_mtime=$(stat_entry "${project_yml}" | awk '{print $1}' || echo 0)
  proj_mtime=$(stat_entry "${xcodeproj}" | awk '{print $1}' || echo 0)

  [[ "${yml_mtime}" -gt "${proj_mtime}" ]]
}

# Run xcodegen to generate the Xcode project
run_xcodegen() {
  if ! command -v xcodegen >/dev/null 2>&1; then
    log_warn "xcodegen not available; skipping project generation."
    return 1
  fi

  log_info "Running xcodegen..."
  if (cd "${CTRL_PROXY_IOS_DIR}" && xcodegen generate); then
    log_info "xcodegen completed."
    return 0
  fi

  log_warn "xcodegen failed."
  return 1
}

# Build CtrlProxy iOS using xcodebuild build-for-testing
build_ctrl_proxy_ios() {
  if ! command -v xcodebuild >/dev/null 2>&1; then
    log_error "xcodebuild not found. Install Xcode."
    return 1
  fi

  if needs_project_generation; then
    run_xcodegen || true
  fi

  log_info "Building CtrlProxy iOS (build-for-testing)..."
  if ! (cd "${CTRL_PROXY_IOS_DIR}" && xcodebuild build-for-testing \
      -scheme CtrlProxyApp \
      -destination "generic/platform=iOS Simulator" \
      -derivedDataPath "${DERIVED_DATA_PATH}" \
      -quiet); then
    log_error "xcodebuild build-for-testing failed."
    return 1
  fi

  if ! "${PROJECT_ROOT}/scripts/ios/patch-ctrl-proxy-ui-test-runner-icon.sh" --derived-data "${DERIVED_DATA_PATH}"; then
    log_error "Failed to patch the CtrlProxy UI-test runner icon."
    return 1
  fi

  return 0
}

# Find the .xctestrun file in derived data
get_xctestrun_path() {
  local products_dir="${DERIVED_DATA_PATH}/Build/Products"
  if [[ ! -d "${products_dir}" ]]; then
    echo ""
    return
  fi

  local xctestrun_file
  xctestrun_file=$(find "${products_dir}" -maxdepth 1 -name "*.xctestrun" \
    ! -name "automobile-runner-*.xctestrun" 2>/dev/null | head -1 || true)
  if [[ -n "${xctestrun_file}" ]]; then
    echo "${xctestrun_file}"
    return
  fi

  echo ""
}

# Start CtrlProxy iOS on a simulator
start_ctrl_proxy_ios() {
  local simulator_id="$1"
  local port="${CTRL_PROXY_IOS_PORT:-8765}"
  local xctestrun_path
  local runner_xctestrun_path
  xctestrun_path="$(get_xctestrun_path)"

  if [[ -z "${simulator_id}" ]]; then
    log_warn "No booted simulator available; cannot start CtrlProxy iOS."
    return 1
  fi

  XCODEBUILD_LOG="${PROJECT_ROOT}/scratch/ios-ctrl-proxy.log"
  if [[ -z "${xctestrun_path}" ]]; then
    log_error "No CtrlProxy .xctestrun file found after build-for-testing."
    return 1
  fi

  stop_ctrl_proxy_ios

  runner_xctestrun_path="$(dirname "${xctestrun_path}")/automobile-runner-${simulator_id}.xctestrun"
  cp "${xctestrun_path}" "${runner_xctestrun_path}"
  plutil -replace "CtrlProxyUITests.EnvironmentVariables.CTRL_PROXY_IOS_PORT" \
    -string "${port}" "${runner_xctestrun_path}"
  plutil -replace "CtrlProxyUITests.EnvironmentVariables.AUTOMOBILE_DEVICE_ID" \
    -string "${simulator_id}" "${runner_xctestrun_path}"
  if [[ -n "${CTRL_PROXY_IOS_BUNDLE_ID:-}" ]]; then
    plutil -replace "CtrlProxyUITests.EnvironmentVariables.CTRL_PROXY_IOS_BUNDLE_ID" \
      -string "${CTRL_PROXY_IOS_BUNDLE_ID}" "${runner_xctestrun_path}"
  fi
  if [[ -n "${CTRL_PROXY_IOS_TIMEOUT:-}" ]]; then
    plutil -replace "CtrlProxyUITests.EnvironmentVariables.CTRL_PROXY_IOS_TIMEOUT" \
      -string "${CTRL_PROXY_IOS_TIMEOUT}" "${runner_xctestrun_path}"
  fi

  local cmd=(
    xcodebuild
    test-without-building
    -xctestrun "${runner_xctestrun_path}"
    -destination "id=${simulator_id}"
    -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService
  )
  local runner_env=(
    "CTRL_PROXY_IOS_PORT=${port}"
    "AUTOMOBILE_DEVICE_ID=${simulator_id}"
  )
  if [[ -n "${CTRL_PROXY_IOS_BUNDLE_ID:-}" ]]; then
    runner_env+=("CTRL_PROXY_IOS_BUNDLE_ID=${CTRL_PROXY_IOS_BUNDLE_ID}")
  fi
  if [[ -n "${CTRL_PROXY_IOS_TIMEOUT:-}" ]]; then
    runner_env+=("CTRL_PROXY_IOS_TIMEOUT=${CTRL_PROXY_IOS_TIMEOUT}")
  fi

  echo "" >> "${XCODEBUILD_LOG}"
  echo "=== CtrlProxy iOS starting at $(date) ===" >> "${XCODEBUILD_LOG}"
  (cd "${CTRL_PROXY_IOS_DIR}" && exec env "${runner_env[@]}" "${cmd[@]}") \
    >> "${XCODEBUILD_LOG}" 2>&1 &
  XCODEBUILD_PID=$!
  printf '%s\n' "${XCODEBUILD_PID}" > "${IOS_RUNNER_PID_FILE}"
  log_info "CtrlProxy iOS started (PID ${XCODEBUILD_PID})"
  log_info "Logs: ${XCODEBUILD_LOG}"
  return 0
}

# Stop CtrlProxy iOS process
stop_ctrl_proxy_ios() {
  if [[ -z "${XCODEBUILD_PID}" ]] && [[ -f "${IOS_RUNNER_PID_FILE}" ]]; then
    XCODEBUILD_PID=$(cat "${IOS_RUNNER_PID_FILE}" 2>/dev/null || true)
  fi
  if [[ -n "${XCODEBUILD_PID}" ]] && ! [[ "${XCODEBUILD_PID}" =~ ^[0-9]+$ ]]; then
    log_warn "Ignoring invalid CtrlProxy iOS runner PID: ${XCODEBUILD_PID}"
    XCODEBUILD_PID=""
  fi
  if [[ -n "${XCODEBUILD_PID}" ]] && kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
    local command
    command=$(ps -p "${XCODEBUILD_PID}" -o args= 2>/dev/null || true)
    if [[ "${command}" != *"xcodebuild"* ]] || [[ "${command}" != *"CtrlProxy"* ]]; then
      log_warn "Refusing to stop recycled/non-CtrlProxy PID ${XCODEBUILD_PID}."
      XCODEBUILD_PID=""
      rm -f "${IOS_RUNNER_PID_FILE}"
      return 0
    fi
  fi
  if [[ -n "${XCODEBUILD_PID}" ]] && kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
    log_info "Stopping CtrlProxy iOS (PID ${XCODEBUILD_PID})..."
    kill "${XCODEBUILD_PID}" 2>/dev/null || true

    # Wait up to 5 seconds for graceful exit
    local count=0
    while kill -0 "${XCODEBUILD_PID}" 2>/dev/null && [[ ${count} -lt 5 ]]; do
      sleep 1
      count=$((count + 1))
    done

    # Force kill if still running
    if kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
      log_warn "Force killing CtrlProxy iOS..."
      kill -9 "${XCODEBUILD_PID}" 2>/dev/null || true
    fi
  fi
  XCODEBUILD_PID=""
  rm -f "${IOS_RUNNER_PID_FILE}"
}

# Watch for changes and rebuild/restart
# Args: poll_interval
watch_loop() {
  local poll_interval="${1:-2}"
  local last_hash
  local last_simulator=""
  local needs_restart=false

  log_info "Watching for changes (poll interval ${poll_interval}s)."
  last_hash="$(hash_watch_state)"

  # Initial build
  if ! build_ctrl_proxy_ios; then
    log_warn "Initial build failed; waiting for changes."
  fi

  while true; do
    sleep "${poll_interval}"

    local current_simulator
    if [[ -n "${SIMULATOR_ID_OVERRIDE:-}" ]]; then
      if xcrun simctl list devices booted -j 2>/dev/null | \
        grep -q "\"${SIMULATOR_ID_OVERRIDE}\""; then
        current_simulator="${SIMULATOR_ID_OVERRIDE}"
      else
        current_simulator=""
      fi
    else
      current_simulator=$(xcrun simctl list devices booted -j 2>/dev/null | \
        grep -o '"udid" : "[^"]*"' | head -1 | sed 's/"udid" : "//;s/"$//')
    fi

    if [[ "${current_simulator}" != "${last_simulator}" ]]; then
      if [[ -n "${current_simulator}" ]]; then
        log_info "Booted simulator: ${current_simulator}"
        needs_restart=true
      else
        log_warn "No booted simulator detected."
      fi
      last_simulator="${current_simulator}"
    fi

    local next_hash
    next_hash="$(hash_watch_state)"
    if [[ "${next_hash}" != "${last_hash}" ]]; then
      log_info "Change detected. Rebuilding..."
      if build_ctrl_proxy_ios; then
        last_hash="$(hash_watch_state)"
        needs_restart=true
      else
        log_warn "Build failed; waiting for next change."
      fi
    fi

    if [[ -n "${XCODEBUILD_PID}" ]] && ! kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
      log_warn "CtrlProxy iOS process exited."
      XCODEBUILD_PID=""
      needs_restart=true
    fi

    if [[ "${needs_restart}" == "true" ]] && [[ -n "${last_simulator}" ]]; then
      stop_ctrl_proxy_ios
      start_ctrl_proxy_ios "${last_simulator}"
      needs_restart=false
    fi
  done
}
