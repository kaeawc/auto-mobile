#!/usr/bin/env bash
set -euo pipefail
# Intentional conditional calls preserve optional-install and cleanup failure handling.
# shellcheck disable=SC2310
IFS=$'\n\t'

# Handle piped execution (curl | bash) where BASH_SOURCE is empty
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
else
    SCRIPT_DIR=""
    PROJECT_ROOT="$(pwd)"
fi
if [[ ! -f "${PROJECT_ROOT}/package.json" ]]; then
    PROJECT_ROOT="$(pwd)"
fi

IS_REPO=false
if [[ -f "${PROJECT_ROOT}/package.json" && -d "${PROJECT_ROOT}/android" ]]; then
    IS_REPO=true
fi

# ============================================================================
# New CLI Options and Global State
# ============================================================================
DRY_RUN=false
DRY_RUN_LOG=()
NON_INTERACTIVE=false
RECORD_MODE=false
CONTRIBUTOR_MODE=false
PRESET=""
CONFIGURE_MCP_CLIENTS=false
RUN_NPM_INSTALL=false
ENV_FILE=""
INVOCATION_DIR="$(pwd)"
INVOKED_IN_GIT_REPO=false
MCP_CONFIG_SCOPE=""
MCP_PROJECT_ROOT=""
INSTALL_STEPS=()
CURRENT_INSTALL_STEP=0

# Gum bundling configuration
GUM_VERSION="0.17.0"
GUM_INSTALL_DIR="${HOME}/.automobile/bin"
GUM_BINARY="${GUM_INSTALL_DIR}/gum"
GUM_VERSION_FILE="${GUM_INSTALL_DIR}/.gum-version"

# Config backup directory
BACKUP_DIR="${HOME}/.automobile/backups"
BACKUP_TIMESTAMP=""

# MCP client detection (parallel arrays for bash 3.x compatibility)
# Format: "client_name|config_path|format|scope"
MCP_CLIENT_LIST=()
SELECTED_MCP_CLIENTS=()
PRESET_CLIENT_FILTER=""  # When set, auto-select clients matching this prefix
IOS_RUNTIME_NAMES=()
IOS_RUNTIME_PROBE_PID=""
IOS_RUNTIME_PROBE_FILE=""
IOS_RUNTIME_PROBE_PROCESS_GROUP=false
POST_BUN_SETUP_PID=""
POST_BUN_SETUP_LOG_FILE=""
POST_BUN_SETUP_STATE_FILE=""
DESKTOP_APP_TEMP_DIR=""
DESKTOP_APP_MOUNT_DIR=""
DESKTOP_APP_REPLACEMENT_LOCK_DIR=""
DESKTOP_APP_REPLACEMENT_STAGING_DIR=""
DESKTOP_APP_REPLACEMENT_TARGET=""
DESKTOP_APP_REPLACEMENT_PREVIOUS=""
DESKTOP_APP_REPLACEMENT_COMPLETE=false

# ============================================================================
# Original Global State
# ============================================================================
INSTALL_BUN=false
BUN_INSTALLED=false
ANDROID_SDK_DETECTED=false
INSTALL_IDE_PLUGIN=false
IDE_PLUGIN_METHOD=""
IDE_PLUGIN_ZIP_URL=""
IDE_PLUGIN_DIR=""
INSTALL_AUTOMOBILE_CLI=false
INSTALL_DESKTOP_APP=false
INSTALL_CLAUDE_MARKETPLACE=false
INSTALL_DEV_TOOLS=false
START_DAEMON=false
DAEMON_STARTED=false
AUTO_MOBILE_CMD=()

# Early detection state
CLI_ALREADY_INSTALLED=false
DAEMON_ALREADY_RUNNING=false
CLAUDE_CLI_INSTALLED=false
CLAUDE_MARKETPLACE_INSTALLED=false
IOS_SETUP_OK=false
ANDROID_SETUP_OK=false

# Track if any changes were made
CHANGES_MADE=false

# Track if ANDROID_HOME was already set in environment
ANDROID_HOME_FROM_ENV=false
if [[ -n "${ANDROID_HOME:-}" ]]; then
    ANDROID_HOME_FROM_ENV=true
fi

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Stop a process tree after first freezing it. Killing only a background Bash
# subshell leaves its active `bun` child running as an orphan, so capture each
# descendant before any parent can exit and re-parent it.
terminate_process_tree() {
    local pid="$1"
    kill -0 "${pid}" 2>/dev/null || return 0

    kill -STOP "${pid}" 2>/dev/null || true

    local children=()
    local child
    if command_exists pgrep; then
        while IFS= read -r child; do
            [[ -n "${child}" ]] && children+=("${child}")
        done < <(pgrep -P "${pid}" . 2>/dev/null || true)
    fi

    # Bash 3 treats an empty array as unset with `set -u` enabled.
    for child in "${children[@]:-}"; do
        terminate_process_tree "${child}"
    done

    # A stopped process holds SIGTERM pending until it is resumed. These are
    # installer-owned worker processes, so use SIGKILL after the recursive
    # walk to guarantee cancellation cannot leave a Bun or daemon child alive.
    kill -KILL "${pid}" 2>/dev/null || true
}

# Reap installer background work and remove its temporary files. The runtime
# probe and post-Bun setup are always awaited during a normal install; this is
# only the cancellation/error path that prevents an orphaned child process.
cleanup_background_installer_work() {
    local pid
    for pid in "${IOS_RUNTIME_PROBE_PID}" "${POST_BUN_SETUP_PID}"; do
        if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
            terminate_process_tree "${pid}"
            wait "${pid}" 2>/dev/null || true
        fi
    done

    [[ -n "${IOS_RUNTIME_PROBE_FILE}" ]] && rm -f "${IOS_RUNTIME_PROBE_FILE}"
    [[ -n "${POST_BUN_SETUP_LOG_FILE}" ]] && rm -f "${POST_BUN_SETUP_LOG_FILE}"
    [[ -n "${POST_BUN_SETUP_STATE_FILE}" ]] && rm -f "${POST_BUN_SETUP_STATE_FILE}"
    cleanup_macos_desktop_app_replacement
    cleanup_desktop_app_installer
    return 0
}

# Detect the Git project containing the directory where the installer was run.
# This is intentionally separate from PROJECT_ROOT, which is used to locate
# this repository when contributors run the script from a checkout.
detect_invocation_project() {
    INVOKED_IN_GIT_REPO=false
    MCP_PROJECT_ROOT=""

    if ! command -v git >/dev/null 2>&1; then
        return 0
    fi

    local git_root
    if git_root=$(git -C "${INVOCATION_DIR}" rev-parse --show-toplevel 2>/dev/null); then
        INVOKED_IN_GIT_REPO=true
        MCP_PROJECT_ROOT="${git_root}"
    fi
}

# Choose where the user's MCP configuration belongs before selecting agents.
select_mcp_config_scope() {
    # Dry-run and record mode use the same safe defaults as non-interactive
    # installs so neither mode waits for a scope-selection prompt.
    if [[ "${NON_INTERACTIVE}" == "true" || "${DRY_RUN}" == "true" || "${RECORD_MODE}" == "true" ]]; then
        if [[ "${INVOKED_IN_GIT_REPO}" == "true" ]]; then
            MCP_CONFIG_SCOPE="project"
        else
            MCP_CONFIG_SCOPE="global"
        fi
        return 0
    fi

    if [[ "${INVOKED_IN_GIT_REPO}" == "true" ]]; then
        local choice
        choice=$(printf '%s\n' \
            "Project — configure this Git project (${MCP_PROJECT_ROOT})" \
            "Global — configure all of your projects" | \
            command gum choose --header "Where should AutoMobile be configured?"
            true)

        if [[ "${choice}" == Project* ]]; then
            MCP_CONFIG_SCOPE="project"
        elif [[ "${choice}" == Global* ]]; then
            MCP_CONFIG_SCOPE="global"
        else
            echo ""
            echo "Installation cancelled."
            exit 130
        fi
        return 0
    fi

    if gum confirm "This command was not run inside a Git project. Install AutoMobile globally?" --default=false; then
        MCP_CONFIG_SCOPE="global"
        return 0
    fi

    log_info "Run this installer from within a Git project to configure AutoMobile for that project."
    exit 0
}

# Keep the installer plan visible so users can see both what will happen and
# which phase is currently running.
set_installation_steps() {
    INSTALL_STEPS=("$@")
}

show_installation_progress() {
    local current_step="$1"
    CURRENT_INSTALL_STEP="${current_step}"

    echo ""
    gum style --bold "Installation plan"

    local index=1
    local step
    for step in ${INSTALL_STEPS[@]+"${INSTALL_STEPS[@]}"}; do
        if [[ "${index}" -eq "${CURRENT_INSTALL_STEP}" ]]; then
            gum style --bold --foreground 212 "  ${index}. → ${step}"
        else
            gum style --faint "  ${index}.   ${step}"
        fi
        index=$((index + 1))
    done
    echo ""
}

# ============================================================================
# Android SDK platform helpers (issue #2680)
#
# These are intentionally pure (no gum / network / global state) so they can
# be sourced and unit-tested in isolation (see
# test/bats/install-android-sdk-platform.bats).
# ============================================================================

# Read the required Android compileSdk version from libs.versions.toml so the
# installer never hardcodes the platform number — bumping
# `build-android-compileSdk` is the single source of truth.
# Echoes the version (e.g. "37") on success; non-zero exit if missing/unreadable.
read_required_compile_sdk() {
    local toml_file="$1"
    [[ -f "${toml_file}" ]] || return 1

    local version
    version=$(grep -E '^[[:space:]]*build-android-compileSdk[[:space:]]*=' "${toml_file}" 2>/dev/null \
        | head -1 \
        | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')

    [[ -n "${version}" ]] || return 1
    printf '%s\n' "${version}"
}

# Verify the Gradle-required SDK platform (the android.jar) is actually
# installed under ${android_home}/platforms/android-<compileSdk>. Mirrors the
# build's fallback (android/video-server/build.gradle.kts), which accepts both
# the `android-<sdk>` and `android-<sdk>.0` directory layouts.
# Returns 0 when present, non-zero otherwise.
android_platform_installed() {
    local android_home="$1"
    local compile_sdk="$2"
    [[ -n "${android_home}" && -n "${compile_sdk}" ]] || return 1
    [[ -f "${android_home}/platforms/android-${compile_sdk}/android.jar" \
        || -f "${android_home}/platforms/android-${compile_sdk}.0/android.jar" ]]
}

# Locate the sdkmanager binary so we can surface an exact install command.
# Prefers the modern cmdline-tools layout, then any versioned cmdline-tools
# dir, then the legacy tools/bin location. Echoes the path on success.
find_sdkmanager() {
    local android_home="$1"
    [[ -n "${android_home}" ]] || return 1

    local candidate
    if [[ -x "${android_home}/cmdline-tools/latest/bin/sdkmanager" ]]; then
        printf '%s\n' "${android_home}/cmdline-tools/latest/bin/sdkmanager"
        return 0
    fi

    for candidate in "${android_home}"/cmdline-tools/*/bin/sdkmanager; do
        if [[ -x "${candidate}" ]]; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done

    if [[ -x "${android_home}/tools/bin/sdkmanager" ]]; then
        printf '%s\n' "${android_home}/tools/bin/sdkmanager"
        return 0
    fi

    return 1
}

# Compose the helpers into the installer's decision. Given an SDK home and the
# libs.versions.toml, determine whether the Gradle-required platform is present
# and, when not, print the exact sdkmanager install command on stdout.
# Exit codes (mirrored into the installer's status + messaging):
#   0 = platform installed (ok)
#   1 = unable to determine required compileSdk (no toml / key) — skip silently
#   2 = platform missing (stdout = actionable `sdkmanager "platforms;..."` cmd)
android_platform_install_advice() {
    local android_home="$1"
    local libs_toml="$2"

    local compile_sdk
    if compile_sdk=$(read_required_compile_sdk "${libs_toml}"); then
        :
    else
        return 1
    fi

    if android_platform_installed "${android_home}" "${compile_sdk}"; then
        return 0
    fi

    local sdkmanager_path
    if sdkmanager_path=$(find_sdkmanager "${android_home}"); then
        printf '"%s" "platforms;android-%s"\n' "${sdkmanager_path}" "${compile_sdk}"
    else
        printf 'sdkmanager "platforms;android-%s"\n' "${compile_sdk}"
    fi
    return 2
}

# Compare semver versions: returns 0 if $1 >= $2
version_gte() {
    local v1="$1"
    local v2="$2"
    local sorted
    sorted=$(printf '%s\n%s\n' "$v1" "$v2" | sort -V | head -n1)
    [[ "$sorted" == "$v2" ]]
}

# Required versions (populated by parse_required_versions)
REQUIRED_BUN_VERSION=""

# Parse required versions from package.json (only when IS_REPO=true)
parse_required_versions() {
    if [[ "${IS_REPO}" != "true" ]]; then
        return 0
    fi

    local package_json="${PROJECT_ROOT}/package.json"
    if [[ ! -f "${package_json}" ]]; then
        return 0
    fi

    # Extract bun version from packageManager field (e.g., "bun@1.3.14")
    REQUIRED_BUN_VERSION=$(grep -o '"packageManager":[[:space:]]*"bun@[^"]*"' "${package_json}" | \
        sed 's/.*bun@\([^"]*\).*/\1/' || true)

    if [[ -z "${REQUIRED_BUN_VERSION}" ]]; then
        # Fallback to engines.bun field
        REQUIRED_BUN_VERSION=$(grep -o '"bun":[[:space:]]*"[^"]*"' "${package_json}" | \
            head -1 | sed 's/.*">=\{0,1\}\([0-9.]*\).*/\1/' || true)
    fi

}

# Write environment state to a file for the caller to source
write_env_file() {
    if [[ -z "${ENV_FILE}" ]]; then
        return 0
    fi

    {
        echo "export PATH=\"${PATH}\""
        if [[ -n "${ANDROID_HOME:-}" ]]; then
            echo "export ANDROID_HOME=\"${ANDROID_HOME}\""
        fi
    } > "${ENV_FILE}"
}

# Check if auto-mobile CLI is installed
is_cli_installed() {
    command_exists auto-mobile
}

# Check if MCP daemon is running (fast check - just verify socket exists)
is_daemon_running() {
    local socket_path
    socket_path="/tmp/auto-mobile-daemon-$(id -u).sock"
    [[ -S "${socket_path}" ]]
}

# Read daemon version from PID file. Returns empty string if unreadable.
get_running_daemon_version() {
    local pid_file
    pid_file="/tmp/auto-mobile-daemon-$(id -u).pid"
    if [[ ! -f "${pid_file}" ]]; then
        echo ""
        return 0
    fi

    if command_exists jq; then
        jq -r '.version // empty' "${pid_file}" 2>/dev/null || echo ""
    elif command_exists python3; then
        python3 -c "import json,sys; print(json.load(open('${pid_file}')).get('version',''))" 2>/dev/null || echo ""
    else
        # Fallback: grep for version field
        grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${pid_file}" 2>/dev/null | \
            sed 's/.*"\([^"]*\)"$/\1/' || echo ""
    fi
}

# Get the package version from package.json (the version we're installing)
get_package_version() {
    if [[ "${IS_REPO}" == "true" ]] && [[ -f "${PROJECT_ROOT}/package.json" ]]; then
        if command_exists jq; then
            jq -r '.version // empty' "${PROJECT_ROOT}/package.json" 2>/dev/null || echo ""
        else
            grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${PROJECT_ROOT}/package.json" 2>/dev/null | \
                head -1 | sed 's/.*"\([^"]*\)"$/\1/' || echo ""
        fi
    else
        echo ""
    fi
}

# Check if Claude CLI is installed
is_claude_cli_installed() {
    command_exists claude
}

# Check if auto-mobile marketplace plugin is already installed
is_claude_marketplace_installed() {
    if ! command_exists claude; then
        return 1
    fi
    # Check if auto-mobile marketplace is in the list
    claude plugin marketplace list 2>/dev/null | grep -q "auto-mobile" 2>/dev/null
}

# Perform early detection of installed components (fast checks only, before gum)
detect_existing_setup() {
    if is_cli_installed; then
        CLI_ALREADY_INSTALLED=true
    fi

    if is_daemon_running; then
        DAEMON_ALREADY_RUNNING=true
    fi

    if is_claude_cli_installed; then
        CLAUDE_CLI_INSTALLED=true
        # Note: marketplace check is deferred to after gum is available (slow network call)
    fi
}

# ============================================================================
# CLI Argument Parsing
# ============================================================================
show_help() {
    cat << 'EOF'
AutoMobile Installer

Usage: ./scripts/install.sh [OPTIONS]

Options:
  --dry-run           Show what would happen without making changes
  --record-mode       Auto-select defaults and run (for demo recording)
  --preset NAME       Use an installation preset (minimal; contributor-only: development, local-dev)
  --contributor       Use contributor defaults (automatically selects the development preset)
  --non-interactive   Skip interactive prompts, use defaults
  --desktop-app       Install the native AutoMobile desktop app from the latest GitHub release
  --env-file PATH     Write environment state (PATH, ANDROID_HOME) to file
  -h, --help          Show this help message

Presets:
  minimal      - Configure an installed MCP client to run AutoMobile (default)

Contributor presets (require --contributor):
  development  - Install contributor tools, enable debug logging, and configure MCP clients
  local-dev    - Install dependencies for a local checkout and hot reload

Examples:
  ./scripts/install.sh --dry-run
  ./scripts/install.sh --record-mode
  ./scripts/install.sh
  ./scripts/install.sh --contributor
  ./scripts/install.sh --contributor --preset local-dev --non-interactive --env-file /tmp/env

EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --preset)
                if [[ -z "${2:-}" ]]; then
                    plain_error "Missing value for --preset"
                    exit 1
                fi
                PRESET="$2"
                shift 2
                ;;
            --non-interactive|-y)
                NON_INTERACTIVE=true
                shift
                ;;
            --desktop-app)
                INSTALL_DESKTOP_APP=true
                shift
                ;;
            --record-mode)
                RECORD_MODE=true
                shift
                ;;
            --contributor)
                CONTRIBUTOR_MODE=true
                shift
                ;;
            --env-file)
                if [[ -z "${2:-}" ]]; then
                    plain_error "Missing value for --env-file"
                    exit 1
                fi
                ENV_FILE="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                plain_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # Validate preset if provided. Development presets are intentionally gated so
    # the public installer stays focused on the end-user setup path.
    if [[ -n "${PRESET}" ]]; then
        case "${PRESET}" in
            minimal|development|local-dev)
                ;;
            *)
                plain_error "Unknown preset: ${PRESET}. Valid options: minimal, development, local-dev"
                exit 1
                ;;
        esac

        if [[ ( "${PRESET}" == "development" || "${PRESET}" == "local-dev" ) && "${CONTRIBUTOR_MODE}" != "true" ]]; then
            plain_error "The ${PRESET} preset is for contributors. Re-run with --contributor."
            exit 1
        fi
    elif [[ "${CONTRIBUTOR_MODE}" == "true" ]]; then
        # Contributors should not need to select a development route from an
        # end-user menu; the flag itself opts into the full contributor setup.
        PRESET="development"
    fi
}

# ============================================================================
# Dry-Run Wrapper Functions
# ============================================================================
# Execute a command or log it in dry-run mode
execute() {
    local description="$1"
    shift

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] ${description}")
        if command_exists gum; then
            gum log --level info "[DRY-RUN] Would: ${description}"
        else
            printf '[DRY-RUN] Would: %s\n' "${description}"
        fi
        return 0
    fi

    "$@"
}

# Execute with spinner or log in dry-run mode
execute_spinner() {
    local title="$1"
    shift

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] ${title}")
        if command_exists gum; then
            gum log --level info "[DRY-RUN] Would: ${title}"
        else
            printf '[DRY-RUN] Would: %s\n' "${title}"
        fi
        return 0
    fi

    run_spinner "${title}" "$@"
}

# Write file with diff preview and user approval
write_file() {
    local path="$1"
    local content="$2"
    local description="${3:-Write to ${path}}"

    # Get existing content if file exists
    local existing_content=""
    if [[ -f "${path}" ]]; then
        existing_content=$(cat "${path}" 2>/dev/null || echo "")
    fi

    # Check if content is actually different
    if [[ "${existing_content}" == "${content}" ]]; then
        log_info "No changes needed for ${path}"
        return 0
    fi

    # Show the diff
    if [[ -f "${path}" ]]; then
        show_colored_diff "${existing_content}" "${content}" "${path}"
    else
        show_new_file "${content}" "${path}"
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] ${description}")
        log_info "[DRY-RUN] Would write to: ${path}"
        return 0
    fi

    # Ask for approval (skip in non-interactive mode)
    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        if ! gum confirm "Apply these changes to ${path}?"; then
            log_info "Skipped changes to ${path}"
            return 0
        fi
    fi

    # Create parent directory if needed
    local parent_dir
    parent_dir=$(dirname "${path}")
    if [[ ! -d "${parent_dir}" ]]; then
        mkdir -p "${parent_dir}"
    fi

    printf '%s\n' "${content}" > "${path}"
    log_info "Updated ${path}"
}

# Print dry-run summary at the end
print_dry_run_summary() {
    if [[ "${DRY_RUN}" != "true" ]]; then
        return 0
    fi

    if [[ ${#DRY_RUN_LOG[@]} -eq 0 ]]; then
        log_info "Dry-run complete. No actions would be taken."
        return 0
    fi

    echo ""
    gum style --bold --foreground 214 "Dry-Run Summary"
    gum style --faint "The following actions would be performed:"
    echo ""

    local i=1
    for action in ${DRY_RUN_LOG[@]+"${DRY_RUN_LOG[@]}"}; do
        # Strip [DRY-RUN] prefix for cleaner output
        local clean_action="${action#\[DRY-RUN\] }"
        printf '  %d. %s\n' "${i}" "${clean_action}"
        ((i++))
    done

    echo ""
    gum style --foreground 214 "Run without --dry-run to execute these actions."
}

# Terminal colors for diffs
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'
BOLD='\033[1m'

# Show a colored diff between old and new content
show_colored_diff() {
    local old_content="$1"
    local new_content="$2"
    local file_path="$3"

    local temp_old temp_new
    temp_old=$(mktemp)
    temp_new=$(mktemp)

    printf '%s\n' "${old_content}" > "${temp_old}"
    printf '%s\n' "${new_content}" > "${temp_new}"

    echo ""
    printf '%b--- %s (current)%b\n' "${BOLD}" "${file_path}" "${RESET}"
    printf '%b+++ %s (proposed)%b\n' "${BOLD}" "${file_path}" "${RESET}"

    # Generate unified diff (diff returns 1 when files differ, which is expected)
    local diff_output
    diff_output=$(diff -u "${temp_old}" "${temp_new}" 2>/dev/null || true)

    # Skip the first 2 lines (header) and colorize
    echo "${diff_output}" | tail -n +3 | while IFS= read -r line; do
        case "${line}" in
            -*)
                printf '%b%s%b\n' "${RED}" "${line}" "${RESET}"
                ;;
            +*)
                printf '%b%s%b\n' "${GREEN}" "${line}" "${RESET}"
                ;;
            @*)
                printf '%b%s%b\n' "${CYAN}" "${line}" "${RESET}"
                ;;
            *)
                printf '%s\n' "${line}"
                ;;
        esac
    done

    rm -f "${temp_old}" "${temp_new}"
    echo ""
}

# Show new file content (all green)
show_new_file() {
    local content="$1"
    local file_path="$2"

    echo ""
    printf '%b+++ %s (new file)%b\n' "${BOLD}" "${file_path}" "${RESET}"
    echo ""
    while IFS= read -r line; do
        printf '%b+%s%b\n' "${GREEN}" "${line}" "${RESET}"
    done <<< "${content}"
    echo ""
}

plain_info() {
    printf '[INFO] %s\n' "$1"
}

plain_warn() {
    printf '[WARN] %s\n' "$1"
}

plain_error() {
    printf '[ERROR] %s\n' "$1" >&2
}

# Test whether we can actually open /dev/tty (controlling terminal).
# The device node may exist even when no controlling terminal is attached
# (CI, cron, detached shells), so we must try opening it.
has_controlling_tty() {
    : < /dev/tty 2>/dev/null
}

prompt_confirm_plain() {
    local prompt="$1"
    local reply=""
    # Read from /dev/tty so prompts work even when stdin is a pipe (curl | bash)
    read -r -p "${prompt} [y/N] " reply < /dev/tty
    case "${reply}" in
        y|Y|yes|YES)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Offer to set ANDROID_HOME in a shell profile
# Called when SDK is detected but ANDROID_HOME is not set in environment
offer_android_home_shell_setup() {
    local detected_path="$1"

    # Common shell profile files
    local profile_files=(
        "${HOME}/.zshrc"
        "${HOME}/.zprofile"
        "${HOME}/.bash_profile"
        "${HOME}/.bashrc"
        "${HOME}/.profile"
    )

    # First, check if ANDROID_HOME is already configured in any profile file
    local configured_in=""
    for profile in "${profile_files[@]}"; do
        if [[ -f "${profile}" ]] && grep -q "ANDROID_HOME" "${profile}" 2>/dev/null; then
            configured_in="${profile}"
            break
        fi
    done

    # If already configured in a profile, offer to source it
    if [[ -n "${configured_in}" ]]; then
        local short_name="${configured_in#"${HOME}"/}"
        log_info "ANDROID_HOME is configured in ~/${short_name} but not loaded in current shell"

        if [[ "${NON_INTERACTIVE}" == "true" ]]; then
            log_info "Run: source ~/${short_name}"
            return 0
        fi

        # Extract ANDROID_HOME value from the file (don't source - may have shell-specific syntax)
        local extracted_value
        extracted_value=$(grep -E '^\s*(export\s+)?ANDROID_HOME=' "${configured_in}" 2>/dev/null | head -1 | sed -E 's/.*ANDROID_HOME=["'\'']?([^"'\'']+)["'\'']?.*/\1/')

        # Expand $HOME if present in the value
        extracted_value="${extracted_value/\$HOME/${HOME}}"
        extracted_value="${extracted_value/\~/${HOME}}"

        if [[ -n "${extracted_value}" ]]; then
            log_info "Found: ANDROID_HOME=${extracted_value}"

            if gum confirm "Set ANDROID_HOME for this session?"; then
                export ANDROID_HOME="${extracted_value}"
                log_info "ANDROID_HOME set for current session"
                # Update our tracking variable since it's now set
                ANDROID_HOME_FROM_ENV=true
            else
                log_info "Skipped setting ANDROID_HOME"
                log_info "Run 'source ~/${short_name}' in your shell to load it"
            fi
        else
            log_warn "Could not extract ANDROID_HOME value from ~/${short_name}"
            log_info "Run 'source ~/${short_name}' manually in your shell"
        fi
        return 0
    fi

    # ANDROID_HOME not configured anywhere - offer to add it
    # Skip in non-interactive mode
    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        log_warn "ANDROID_HOME is not set in your environment"
        log_info "Add this to your shell profile: export ANDROID_HOME=\"${detected_path}\""
        return 0
    fi

    log_warn "ANDROID_HOME is not configured in any shell profile"
    log_info "The Android SDK was found at: ${detected_path}"
    echo ""

    # Build options list - existing files first, then creatable files
    local existing_files=()
    local creatable_files=()

    for profile in "${profile_files[@]}"; do
        local short_name="${profile#"${HOME}"/}"
        # shellcheck disable=SC2088 # Tilde is intentional for display purposes
        if [[ -f "${profile}" ]]; then
            existing_files+=("~/${short_name}")
        else
            creatable_files+=("~/${short_name} (create)")
        fi
    done

    # Build final options array (handle empty arrays safely with set -u)
    local options=()
    if [[ ${#existing_files[@]} -gt 0 ]]; then
        options+=("${existing_files[@]}")
    fi
    if [[ ${#creatable_files[@]} -gt 0 ]]; then
        options+=("${creatable_files[@]}")
    fi
    options+=("Skip (I'll set it manually)")

    local choice
    choice=$(printf '%s\n' ${options[@]+"${options[@]}"} | gum choose --header "Add ANDROID_HOME to shell profile?")

    if [[ -z "${choice}" || "${choice}" == "Skip (I'll set it manually)" ]]; then
        log_info "Skipped ANDROID_HOME shell setup"
        log_info "You can add this manually: export ANDROID_HOME=\"${detected_path}\""
        return 0
    fi

    # Extract the file path from the choice
    local selected_file="${choice% (create)}"  # Remove "(create)" suffix if present
    selected_file="${selected_file/#\~/${HOME}}"  # Expand ~ to HOME

    # Prepare the export line
    local export_line="export ANDROID_HOME=\"${detected_path}\""
    # shellcheck disable=SC2016 # Single quotes intentional - we want literal $ANDROID_HOME in file
    local path_line='export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"'

    # Check if already present
    if [[ -f "${selected_file}" ]] && grep -q "ANDROID_HOME" "${selected_file}" 2>/dev/null; then
        log_info "ANDROID_HOME is already configured in ${choice% (create)}"
        return 0
    fi

    # Prepare the content to append
    local append_content
    append_content=$(cat << EOF

# Android SDK (added by auto-mobile installer)
${export_line}
${path_line}
EOF
)

    # Show what will be added
    local current_content=""
    if [[ -f "${selected_file}" ]]; then
        current_content=$(cat "${selected_file}" 2>/dev/null || true)
    fi
    local new_content="${current_content}${append_content}"

    if [[ -f "${selected_file}" ]]; then
        show_colored_diff "${current_content}" "${new_content}" "${selected_file}"
    else
        show_new_file "${new_content}" "${selected_file}"
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Add ANDROID_HOME to ${selected_file}")
        log_info "[DRY-RUN] Would add ANDROID_HOME to: ${selected_file}"
        return 0
    fi

    if ! gum confirm "Apply these changes to ${selected_file}?"; then
        log_info "Skipped ANDROID_HOME shell setup"
        return 0
    fi

    # Append to file (create if doesn't exist)
    printf '%s\n' "${append_content}" >> "${selected_file}"
    log_info "Added ANDROID_HOME to ${selected_file}"
    log_info "Run 'source ${selected_file}' or open a new terminal to apply"
    CHANGES_MADE=true
}

detect_os() {
    case "$(uname -s)" in
        Darwin*)
            echo "macos"
            ;;
        Linux*)
            echo "linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "linux"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)
            echo "x86_64"
            ;;
        arm64|aarch64)
            echo "arm64"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

download_file() {
    local url="$1"
    local destination="$2"

    if command_exists curl; then
        curl --fail --show-error --silent --location \
            --retry 3 --retry-delay 2 --retry-all-errors \
            "${url}" -o "${destination}"
    elif command_exists wget; then
        wget --quiet --tries=3 --waitretry=2 -O "${destination}" "${url}"
    else
        return 1
    fi
}

fetch_gum_version() {
    local version=""

    if command_exists curl; then
        version=$(curl -s "https://api.github.com/repos/charmbracelet/gum/releases/latest" \
            | sed -nE 's/.*"tag_name": "v?([^"]+)".*/\1/p' \
            | head -n 1)
    elif command_exists wget; then
        version=$(wget -qO- "https://api.github.com/repos/charmbracelet/gum/releases/latest" \
            | sed -nE 's/.*"tag_name": "v?([^"]+)".*/\1/p' \
            | head -n 1)
    fi

    if [[ -z "${version}" ]]; then
        version="0.17.0"
    fi

    echo "${version}"
}

# Check if bundled gum is installed and current version
is_bundled_gum_current() {
    if [[ ! -x "${GUM_BINARY}" ]]; then
        return 1
    fi

    if [[ ! -f "${GUM_VERSION_FILE}" ]]; then
        return 1
    fi

    local installed_version
    installed_version=$(cat "${GUM_VERSION_FILE}" 2>/dev/null || echo "")

    [[ "${installed_version}" == "${GUM_VERSION}" ]]
}

# Install gum to ~/.automobile/bin (bundled approach)
install_bundled_gum() {
    local os="$1"
    local arch="$2"
    local os_label=""
    local arch_label=""

    case "${os}" in
        macos)
            os_label="Darwin"
            ;;
        linux)
            os_label="Linux"
            ;;
        *)
            plain_error "Unsupported OS for gum install: ${os}"
            return 1
            ;;
    esac

    case "${arch}" in
        x86_64)
            arch_label="x86_64"
            ;;
        arm64)
            arch_label="arm64"
            ;;
        *)
            plain_error "Unsupported architecture for gum install: ${arch}"
            return 1
            ;;
    esac

    if ! command_exists curl && ! command_exists wget; then
        plain_error "Missing curl or wget; install one to download gum."
        return 1
    fi

    local download_url="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_${os_label}_${arch_label}.tar.gz"

    plain_info "Downloading gum ${GUM_VERSION} to ${GUM_INSTALL_DIR}..."

    local temp_dir
    temp_dir=$(mktemp -d)
    local archive_path="${temp_dir}/gum.tar.gz"

    if ! download_file "${download_url}" "${archive_path}"; then
        plain_error "Failed to download gum from ${download_url}"
        rm -rf "${temp_dir}"
        return 1
    fi

    tar -xzf "${archive_path}" -C "${temp_dir}"

    mkdir -p "${GUM_INSTALL_DIR}"
    mv "${temp_dir}"/gum_*/gum "${GUM_BINARY}"
    chmod +x "${GUM_BINARY}"
    echo "${GUM_VERSION}" > "${GUM_VERSION_FILE}"
    rm -rf "${temp_dir}"

    if [[ ":${PATH}:" != *":${GUM_INSTALL_DIR}:"* ]]; then
        export PATH="${GUM_INSTALL_DIR}:${PATH}"
    fi

    plain_info "gum ${GUM_VERSION} installed to ${GUM_INSTALL_DIR}"
}

# Legacy function for backward compatibility - now redirects to bundled install
install_gum_manual() {
    local os="$1"
    local arch="$2"
    install_bundled_gum "${os}" "${arch}"
}

install_gum() {
    local os
    os=$(detect_os)
    local arch
    arch=$(detect_arch)

    if [[ "${os}" == "unknown" || "${arch}" == "unknown" ]]; then
        plain_error "Unsupported platform: ${os}/${arch}"
        return 1
    fi

    if command_exists brew; then
        plain_info "Installing gum with Homebrew..."
        brew install gum
        return 0
    fi

    if [[ "${os}" == "linux" ]]; then
        if install_gum_linux; then
            return 0
        fi
    fi

    install_gum_manual "${os}" "${arch}"
}

ensure_gum() {
    # 1. Check bundled gum first (preferred)
    if is_bundled_gum_current; then
        export PATH="${GUM_INSTALL_DIR}:${PATH}"
        return 0
    fi

    # 2. Check system gum
    if command_exists gum; then
        return 0
    fi

    # 3. Check ~/.local/bin (previous install location)
    if [[ -x "${HOME}/.local/bin/gum" ]]; then
        export PATH="${HOME}/.local/bin:${PATH}"
        return 0
    fi

    # 4. Need to install - prompt user
    plain_warn "gum is required for the interactive installer."

    local os
    os=$(detect_os)
    local arch
    arch=$(detect_arch)

    if [[ "${NON_INTERACTIVE}" == "true" ]] || ! has_controlling_tty; then
        # In non-interactive mode or when no controlling terminal is available, just install bundled gum
        plain_info "Installing bundled gum ${GUM_VERSION}..."
        if ! install_bundled_gum "${os}" "${arch}"; then
            plain_error "gum installation failed."
            exit 1
        fi
    else
        if ! prompt_confirm_plain "Install gum ${GUM_VERSION} to ${GUM_INSTALL_DIR}?"; then
            plain_error "gum is required to continue."
            exit 1
        fi

        # Try bundled install first
        if ! install_bundled_gum "${os}" "${arch}"; then
            # Fall back to system package manager
            plain_warn "Bundled install failed, trying system package manager..."
            if ! install_gum; then
                plain_error "gum installation failed."
                exit 1
            fi
        fi
    fi

    # Verify gum is now available
    if ! command_exists gum; then
        plain_error "gum is still not available on PATH."
        exit 1
    fi
}

log_info() {
    gum log --level info "$1"
}

log_warn() {
    gum log --level warn "$1"
}

log_error() {
    gum log --level error "$1"
}

install_gum_linux() {
    local -a sudo_cmd=()

    if [[ "${EUID}" -ne 0 ]]; then
        if command_exists sudo; then
            sudo_cmd=(sudo)
        else
            plain_warn "sudo not available; falling back to manual gum install."
            return 1
        fi
    fi

    if command_exists apt-get; then
        plain_info "Installing gum with apt-get..."
        if ! ${sudo_cmd[@]+"${sudo_cmd[@]}"} apt-get update; then
            plain_warn "apt-get update failed; falling back to manual gum install."
            return 1
        fi
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} apt-get install -y gum; then
            return 0
        fi
        plain_warn "apt-get install failed; falling back to manual gum install."
    elif command_exists dnf; then
        plain_info "Installing gum with dnf..."
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} dnf install -y gum; then
            return 0
        fi
        plain_warn "dnf install failed; falling back to manual gum install."
    elif command_exists yum; then
        plain_info "Installing gum with yum..."
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} yum install -y gum; then
            return 0
        fi
        plain_warn "yum install failed; falling back to manual gum install."
    elif command_exists pacman; then
        plain_info "Installing gum with pacman..."
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} pacman -S --noconfirm gum; then
            return 0
        fi
        plain_warn "pacman install failed; falling back to manual gum install."
    elif command_exists zypper; then
        plain_info "Installing gum with zypper..."
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} zypper --non-interactive install gum; then
            return 0
        fi
        plain_warn "zypper install failed; falling back to manual gum install."
    elif command_exists apk; then
        plain_info "Installing gum with apk..."
        if ${sudo_cmd[@]+"${sudo_cmd[@]}"} apk add --no-cache gum; then
            return 0
        fi
        plain_warn "apk install failed; falling back to manual gum install."
    fi

    return 1
}

run_spinner() {
    local title="$1"
    shift
    gum spin --spinner dot --title "${title}" -- "$@"
}

# Run command with spinner, show output on failure
run_with_error_output() {
    local title="$1"
    shift

    local output
    local status=0
    output=$("$@" 2>&1) || status=$?

    if [[ ${status} -ne 0 ]]; then
        log_error "${title} failed"
        if [[ -n "${output}" ]]; then
            echo "${output}"
        fi
        return ${status}
    fi

    log_info "${title}: ok"
    return 0
}

# Ceiling, in seconds, for a single package-manager invocation.
#
# A healthy install of anything we ask for finishes in well under a minute; this
# only exists so a stalled package manager cannot consume the whole job.
# `Installer Minimal (ubuntu-latest)` once spent 45 minutes inside one apt-get
# and emitted nothing, leaving the stall unexplainable after the fact (issue
# #4162). A job-level `timeout-minutes` is not a substitute: it kills the job
# without saying which command hung.
#
# 600s is chosen to sit under the installer job's own 20-minute `timeout-minutes`
# — a bound above that would never fire before the job died, which is the
# uninformative outcome this exists to avoid — while staying far above any
# bottled install. Overridable so tests can exercise the bound without waiting
# out a real stall, and so a host doing an unusually slow source build can raise
# it rather than being cut off.
PACKAGE_INSTALL_TIMEOUT_SECONDS="${PACKAGE_INSTALL_TIMEOUT_SECONDS:-600}"

# Resolve a command prefix that bounds an invocation, into BOUNDED_CMD_PREFIX.
# Empty when the host has no timeout binary, in which case run_bounded_install
# falls back to bounded_watchdog_run below rather than running unbounded.
#
# `-k` matters: plain `timeout` sends only TERM, so a package manager that
# ignores it would keep running and keep the captured pipe open past the
# deadline.
#
# Assigns to a global rather than printing so callers can invoke it as a plain
# statement — a function run inside `$(…)` or on the left of `||` has `set -e`
# suppressed inside it (SC2310/SC2311).
#
# Deliberately NOT `--foreground`. That flag stops `timeout` putting the command
# in its own process group, and the group is the only reason the
# `bash -c "a && b"` call sites are bounded at all — bash does not exec the
# package manager there, so a signal aimed at the direct child never reaches it.
# `--foreground` looks like the fix for sudo's password prompt (it is what
# `timeout --help` offers to "allow COMMAND to read from the TTY") but it trades
# the bound away and does not even solve the prompt, which the output capture
# swallows either way. The prompt is handled before the bound instead, in
# ensure_sudo_credentials below.

# How long a command gets between TERM and KILL. Shared with the watchdog
# fallback so both bounding paths escalate identically, and overridable so tests
# can exercise the escalation without waiting out the real grace.
BOUNDED_KILL_GRACE_SECONDS="${BOUNDED_KILL_GRACE_SECONDS:-10}"

BOUNDED_CMD_PREFIX=()
resolve_bounded_cmd_prefix() {
    local secs="$1"
    BOUNDED_CMD_PREFIX=()
    if command_exists timeout; then
        BOUNDED_CMD_PREFIX=(timeout -k "${BOUNDED_KILL_GRACE_SECONDS}" "${secs}")
    elif command_exists gtimeout; then
        BOUNDED_CMD_PREFIX=(gtimeout -k "${BOUNDED_KILL_GRACE_SECONDS}" "${secs}")
    fi
}

# Whether stdin is a terminal, into STDIN_IS_TERMINAL.
#
# Its own function so tests can substitute it: a test harness never has a
# controlling terminal, but the interactive branch it gates is exactly the
# behaviour worth pinning. Assigns to a global rather than returning a status
# for the same reason as resolve_bounded_cmd_prefix — a function used as a
# condition has `set -e` suppressed inside it (SC2310).
STDIN_IS_TERMINAL=false
detect_stdin_terminal() {
    STDIN_IS_TERMINAL=false
    if [[ -t 0 ]]; then
        STDIN_IS_TERMINAL=true
    fi
}

# Whether a bounded invocation will shell out through sudo, into
# BOUNDED_INSTALL_USES_SUDO.
#
# Checks every argument rather than just the first: _install_system_package
# builds `sudo apt-get update && sudo apt-get install …` and hands the whole
# chain to `bash -c`, so sudo is not argument one there.
BOUNDED_INSTALL_USES_SUDO=false
detect_bounded_install_sudo() {
    local arg
    BOUNDED_INSTALL_USES_SUDO=false
    for arg in "$@"; do
        case " ${arg} " in
            *" sudo "*)
                BOUNDED_INSTALL_USES_SUDO=true
                return 0
                ;;
        esac
    done
}

# Refresh sudo's cached credential *before* entering the bound and the capture.
#
# Both of run_bounded_install's properties are hostile to a password prompt:
#
#   - The output is captured, and sudo writes its prompt to stderr, so the
#     prompt never reaches the terminal while it matters. It surfaces later, if
#     at all, replayed out of the captured output after the bound has fired.
#   - The command runs in its own process group (`timeout` calls setpgid, and
#     the watchdog fallback uses `set -m`), which makes it a *background* group
#     with respect to the terminal. A background process reading the controlling
#     terminal gets SIGTTIN and stops, so sudo's read of /dev/tty never
#     completes — the user's keystrokes go to the parent shell instead.
#
# Together those turned an expired credential into a silent hang for the full
# 600s bound, followed by a spurious "exceeded … and was aborted". Refreshing
# here — unbounded, uncaptured, in the caller's own process group — means the
# bounded invocation itself never has to prompt.
SUDO_CREDENTIALS_READY=false
ensure_sudo_credentials() {
    if [[ "${SUDO_CREDENTIALS_READY}" == "true" ]]; then
        return 0
    fi
    # `command -v` rather than the command_exists helper: a function used as a
    # condition has `set -e` suppressed inside it (SC2310).
    if ! command -v sudo > /dev/null 2>&1; then
        return 0
    fi

    # `-n` never prompts, so this is safe to run before knowing whether a
    # terminal exists. It also refreshes the timestamp when one is cached.
    if sudo -n -v 2> /dev/null; then
        SUDO_CREDENTIALS_READY=true
        return 0
    fi

    detect_stdin_terminal
    if [[ "${NON_INTERACTIVE}" == "true" || "${STDIN_IS_TERMINAL}" != "true" ]]; then
        # Prompting with no terminal would trade the old 45-minute stall for a
        # new one. Let the install fail loudly instead.
        log_warn "sudo has no cached credential and this session is not interactive; package installs may fail"
        return 0
    fi

    log_info "Requesting sudo credentials before installing packages"
    if sudo -v; then
        SUDO_CREDENTIALS_READY=true
    else
        log_warn "Could not refresh sudo credentials; package installs may fail"
    fi
    return 0
}

# Bound a command with a pure-bash watchdog, for hosts with no timeout binary.
#
# Writes the command's combined output to <outfile>; returns the command's own
# status, or 124 when the deadline fires (GNU timeout's convention, so the
# caller's 124 handling covers both paths).
#
# This is a deliberate second copy of scripts/ios/run_with_timeout.sh's
# fallback. install.sh is delivered by `curl … | bash` and cannot source a
# sibling file, and the alternative is what this replaces: on a stock macOS host
# — which has neither `timeout` nor `gtimeout` — every bound silently degraded
# to no bound at all, which is precisely the fail-open #4162 exists to close.
# A bounding mechanism that no-ops on the most common developer platform is
# worse than none, because it reads as covered.
#
# Two properties a naive "background it and kill the pid" watchdog does not give
# you, both learned in run_with_timeout.sh:
#
#   1. Return 124 on expiry. Surfacing `wait`'s status instead gives 143
#      (128+SIGTERM), indistinguishable from a command signalled for any other
#      reason.
#   2. Signal the whole process group. Several call sites pass an `&&` chain
#      through `bash -c`, so bash does not exec the package manager; signalling
#      only the direct child leaves the grandchild alive and the bound silently
#      does not apply.
#
# Output goes to a file rather than a command substitution so that a descendant
# which survives the TERM cannot hold the caller blocked waiting for EOF.
#
# Reports through BOUNDED_WATCHDOG_STATUS rather than its own exit status, for
# the same reason resolve_bounded_cmd_prefix assigns to a global: a function on
# the left of `||` has `set -e` suppressed inside it (SC2310).
BOUNDED_WATCHDOG_STATUS=0
bounded_watchdog_run() {
    local secs="$1"
    local outfile="$2"
    shift 2
    BOUNDED_WATCHDOG_STATUS=0

    # The watchdog runs in a subshell and so cannot assign to a variable in this
    # scope; a marker file is how it reports back that it fired.
    # Spell the template out rather than using `mktemp -t <prefix>`: BSD mktemp
    # treats the argument as a prefix, but GNU mktemp requires a trailing
    # XXXXXX and hard-errors on a bare prefix.
    local fired_marker
    if ! fired_marker="$(mktemp "${TMPDIR:-/tmp}/automobile_bounded_install.XXXXXX")"; then
        BOUNDED_WATCHDOG_STATUS=125
        return 0
    fi

    # Monitor mode puts the child in its own process group (pgid == its pid),
    # which is what lets the group-directed kill below reach descendants.
    # Restore the caller's setting right away so job-control notices do not leak
    # into their output.
    local had_monitor=0
    case "$-" in *m*) had_monitor=1 ;; esac
    set -m
    "$@" > "${outfile}" 2>&1 &
    local cmd_pid=$!
    if [[ ${had_monitor} -eq 0 ]]; then set +m; fi

    local grace="${BOUNDED_KILL_GRACE_SECONDS}"
    local waited=0
    # The watcher also starts a child (`sleep`). Give it a separate process
    # group so cancelling a successful install cannot leave that sleep alive
    # until PACKAGE_INSTALL_TIMEOUT_SECONDS expires on macOS bash.
    local watcher_had_monitor=0
    case "$-" in *m*) watcher_had_monitor=1 ;; esac
    set -m
    (
        sleep "${secs}"
        if kill -0 "${cmd_pid}" 2> /dev/null; then
            printf 'fired' > "${fired_marker}"
            # A negative pid targets the process group. Fall back to the bare
            # pid in case the child never became group leader.
            kill -TERM -"${cmd_pid}" 2> /dev/null || kill -TERM "${cmd_pid}" 2> /dev/null || true
            # Same grace as `timeout -k` on the coreutils path, so the two
            # bounding paths escalate identically — but polled rather than slept
            # straight through. The caller now waits for this subshell, so an
            # unconditional sleep would add the whole grace to every timeout,
            # including the common case where the command dies on TERM at once.
            # Poll both forms for the same reason the signals above use both:
            # if the child never became group leader, `-pid` names no group, and
            # testing only that would break out instantly and collapse the grace
            # to zero — TERM and KILL in the same instant, with no chance to
            # clean up.
            while [[ ${waited} -lt ${grace} ]]; do
                if ! kill -0 -"${cmd_pid}" 2> /dev/null && ! kill -0 "${cmd_pid}" 2> /dev/null; then
                    break
                fi
                sleep 1
                waited=$((waited + 1))
            done
            kill -KILL -"${cmd_pid}" 2> /dev/null || kill -KILL "${cmd_pid}" 2> /dev/null || true
        fi
    ) > /dev/null 2>&1 3>&- &
    local watcher_pid=$!
    if [[ ${watcher_had_monitor} -eq 0 ]]; then set +m; fi

    local status=0
    wait "${cmd_pid}" 2> /dev/null || status=$?
    if [[ -s "${fired_marker}" ]]; then
        # Wait out the watcher's TERM-to-KILL escalation before returning.
        # `wait` above returns as soon as the *direct child* exits, and the
        # direct child is frequently a `bash -c` wrapper that dies on TERM while
        # the package manager it spawned ignores it. Returning here reported the
        # install aborted while that process was still running — and it outlived
        # the installer itself. A watchdog that returns before the group is dead
        # does not bound anything. Same contract as
        # scripts/ios/run_with_timeout.sh; the poll above keeps the cost near
        # zero whenever TERM is honoured.
        wait "${watcher_pid}" 2> /dev/null || true
        status=124
    else
        # The watcher may have forked its `sleep` rather than exec'd it. Kill
        # its process group too, otherwise that child can keep a BATS run alive
        # for the full default 600-second package-install budget.
        kill -TERM -"${watcher_pid}" 2> /dev/null || kill "${watcher_pid}" 2> /dev/null || true
        wait "${watcher_pid}" 2> /dev/null || true
        # The watcher can fire between the `wait` above and the kill here.
        if [[ -s "${fired_marker}" ]]; then status=124; fi
    fi
    rm -f "${fired_marker}"
    BOUNDED_WATCHDOG_STATUS="${status}"
    return 0
}

# Run a package install bounded by PACKAGE_INSTALL_TIMEOUT_SECONDS, printing the
# package manager's output when it fails or is aborted.
#
# This is the install-shaped counterpart to run_with_error_output above: the same
# capture-and-surface-on-failure contract, plus the bound and the 124/137
# reporting that tells a stall apart from a genuine failure.
#
# Package installs deliberately do NOT go through run_spinner: `gum spin` hides
# the wrapped command's output as thoroughly as `>/dev/null`, and that
# suppression is half of why #4162 could not be diagnosed. Keeping the output is
# worth more than the spinner.
#
# Both bounding paths route the output to a file rather than a command
# substitution. A `$(…)` capture keeps the caller blocked on EOF for as long as
# any descendant retains the write end of the pipe, which is exactly the process
# the kill escalation is chasing — so the capture would outlive the bound it is
# supposed to be protected by. Writing to a file removes that coupling entirely:
# the output is already on disk when the deadline fires, whatever survives.
run_bounded_install() {
    local title="$1"
    shift

    # Before the bound and before the capture, on purpose. Inside them sudo
    # cannot prompt: the prompt is swallowed by the capture, and the command runs
    # in a background process group where reading the terminal raises SIGTTIN.
    # See ensure_sudo_credentials.
    detect_bounded_install_sudo "$@"
    if [[ "${BOUNDED_INSTALL_USES_SUDO}" == "true" ]]; then
        ensure_sudo_credentials
    fi

    resolve_bounded_cmd_prefix "${PACKAGE_INSTALL_TIMEOUT_SECONDS}"

    local output=""
    local status=0
    local outfile
    outfile="$(mktemp "${TMPDIR:-/tmp}/automobile_install_output.XXXXXX")" || outfile=""
    if [[ -n "${outfile}" && ${#BOUNDED_CMD_PREFIX[@]} -gt 0 ]]; then
        # The `+` guard keeps an empty prefix from tripping `set -u` on bash 3.2.
        ${BOUNDED_CMD_PREFIX[@]+"${BOUNDED_CMD_PREFIX[@]}"} "$@" > "${outfile}" 2>&1 || status=$?
        output="$(cat "${outfile}")"
        rm -f "${outfile}"
    elif [[ -n "${outfile}" ]]; then
        bounded_watchdog_run "${PACKAGE_INSTALL_TIMEOUT_SECONDS}" "${outfile}" "$@"
        status="${BOUNDED_WATCHDOG_STATUS}"
        output="$(cat "${outfile}")"
        rm -f "${outfile}"
    elif [[ ${#BOUNDED_CMD_PREFIX[@]} -gt 0 ]]; then
        # No temp file, but keep the bound: losing the capture is survivable,
        # losing the ceiling is the fail-open #4162 exists to close. The output
        # goes straight to the terminal here rather than being replayed.
        log_warn "${title}: could not create a temp file to capture output; running bounded but uncaptured"
        ${BOUNDED_CMD_PREFIX[@]+"${BOUNDED_CMD_PREFIX[@]}"} "$@" || status=$?
    else
        log_warn "${title}: could not create a temp file to capture output; running unbounded"
        "$@" || status=$?
    fi

    if [[ ${status} -eq 0 ]]; then
        log_info "${title}: ok"
        return 0
    fi

    # GNU timeout reports 124 when it fires; 137 is the follow-up KILL from -k.
    if [[ ${status} -eq 124 || ${status} -eq 137 ]]; then
        log_warn "${title} exceeded ${PACKAGE_INSTALL_TIMEOUT_SECONDS}s and was aborted"
    else
        log_warn "${title} failed (exit ${status})"
    fi

    if [[ -n "${output}" ]]; then
        printf '%s\n' "${output}" >&2
    fi
    return "${status}"
}

spin_check() {
    local label="$1"
    local check_cmd="$2"

    if run_spinner "${label}" bash -c "${check_cmd}"; then
        log_info "${label}: ok"
        return 0
    fi

    log_warn "${label}: missing"
    return 1
}

run_with_progress() {
    local title="$1"
    shift
    # gum doesn't have a progress command, use spinner instead
    run_spinner "${title}" "$@"
}

run_download_with_progress() {
    local title="$1"
    shift

    run_spinner "Preparing ${title}" sleep 0.3
    run_with_progress "${title}" "$@"
}

# Display the AutoMobile logo with animation
# Uses only unicode symbols known to work with agg (DejaVu Sans fallback)
play_logo_animation() {
    local RED=$'\033[31m'
    local GRAY=$'\033[90m'
    local BOLD=$'\033[1m'
    local RESET=$'\033[0m'

    # Truck ASCII art (5 lines, ~17 chars wide)
    local line1="    ${RED}┌───┐${RESET}       "
    local line2="   ${RED}╱    │${RESET}       "
    local line3="${RED}┌─╱     └══════╦${RESET}"
    local line4="${RED}│  ┌──┐   ┌──┐ ║${RESET}"
    local line5="${RED}└──┘${GRAY}()${RED}└───┘${GRAY}()${RED}└─╝${RESET}"

    local car_height=5
    local car_width=17
    local frame_count=12
    local delay=0.045

    # Check terminal capabilities
    if ! command_exists tput || [[ ! -t 1 ]]; then
        echo ""
        echo -e "${line1}"
        echo -e "${line2}"
        echo -e "${line3}"
        echo -e "${line4}  ${BOLD}AutoMobile${RESET}"
        echo -e "${line5}"
        echo ""
        return 0
    fi

    local term_cols
    term_cols=$(tput cols 2>/dev/null || echo 80)

    # Need space for animation
    if (( term_cols < 40 )); then
        echo ""
        echo -e "${line1}"
        echo -e "${line2}"
        echo -e "${line3}"
        echo -e "${line4}  ${BOLD}AutoMobile${RESET}"
        echo -e "${line5}"
        echo ""
        return 0
    fi

    local start_pos=$((term_cols - car_width - 2))
    local end_pos=3

    # Hide cursor
    tput civis 2>/dev/null || true

    # Print empty lines for car
    echo ""
    local i
    for ((i = 0; i < car_height; i++)); do
        echo ""
    done

    # Animation loop
    for ((frame = 0; frame <= frame_count; frame++)); do
        local pos=$((start_pos - (start_pos - end_pos) * frame / frame_count))

        # Move cursor up
        printf "\033[%dA" "${car_height}"

        # Draw each line with position offset
        local lines=("$line1" "$line2" "$line3" "$line4" "$line5")
        for line in "${lines[@]}"; do
            printf "\033[2K"
            if (( pos > 0 )); then
                printf "%*s" "${pos}" ""
            fi
            echo -e "${line}"
        done

        sleep "${delay}"
    done

    # Final frame with title
    printf "\033[%dA" "${car_height}"
    printf "\033[2K%*s%s\n" "${end_pos}" "" "${line1}"
    printf "\033[2K%*s%s\n" "${end_pos}" "" "${line2}"
    printf "\033[2K%*s%s\n" "${end_pos}" "" "${line3}"
    printf "\033[2K%*s%s  ${BOLD}AutoMobile${RESET}\n" "${end_pos}" "" "${line4}"
    printf "\033[2K%*s%s\n" "${end_pos}" "" "${line5}"
    echo ""

    # Show cursor
    tput cnorm 2>/dev/null || true
}

# ============================================================================
# AI Agent Installation Detection
# ============================================================================

# Check if Claude Code CLI is installed
is_claude_code_installed() {
    command_exists claude
}

# Check if Claude Desktop is installed
is_claude_desktop_installed() {
    local os
    os=$(detect_os)
    if [[ "${MCP_CONFIG_SCOPE}" != "project" && "${os}" == "macos" ]]; then
        [[ -d "${HOME}/Library/Application Support/Claude" ]] || [[ -d "/Applications/Claude.app" ]]
    elif [[ "${MCP_CONFIG_SCOPE}" != "project" && "${os}" == "linux" ]]; then
        [[ -d "${HOME}/.config/Claude" ]]
    else
        return 1
    fi
}

# Check if Cursor is installed
is_cursor_installed() {
    [[ -d "${HOME}/.cursor" ]] || command_exists cursor
}

# Check if Windsurf is installed
is_windsurf_installed() {
    [[ -d "${HOME}/.codeium/windsurf" ]] || [[ -d "${HOME}/.codeium" ]] || command_exists windsurf
}

# Check if VS Code is installed
is_vscode_installed() {
    local os
    os=$(detect_os)
    if command_exists code; then
        return 0
    elif [[ "${os}" == "macos" && -d "/Applications/Visual Studio Code.app" ]]; then
        return 0
    elif [[ "${os}" == "linux" && -d "${HOME}/.vscode" ]]; then
        return 0
    fi
    return 1
}

# Check if Codex (OpenAI) is installed
is_codex_installed() {
    [[ -d "${HOME}/.codex" ]] || [[ -d "${MCP_PROJECT_ROOT}/.codex" ]] || command_exists codex
}

# A user-scoped Codex configuration is useful only when Codex itself is
# available to that user. A project .codex directory alone should expose the
# project choice, not create an unrelated user configuration.
is_codex_user_installed() {
    [[ -d "${HOME}/.codex" ]] || command_exists codex
}

# Check if Goose is installed
is_goose_installed() {
    [[ -d "${HOME}/.config/goose" ]] || command_exists goose
}

# ============================================================================
# MCP Client Detection and Configuration
# ============================================================================

# Add a client to the detection list
# Format: "client_name|config_path|format|scope"
add_mcp_client() {
    local name="$1"
    local path="$2"
    local format="$3"
    local scope="$4"
    MCP_CLIENT_LIST+=("${name}|${path}|${format}|${scope}")
}

# Detect all installed MCP clients
detect_mcp_clients() {
    local os
    os=$(detect_os)

    MCP_CLIENT_LIST=()

    # Claude Code uses ~/.claude.json for user scope and .mcp.json for the
    # shared project scope. .claude/settings*.json configures Claude behavior,
    # not MCP servers, so the installer deliberately leaves those files alone.
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]] && is_claude_code_installed; then
        add_mcp_client "Claude Code (User)" "${HOME}/.claude.json" "json" "global"
    fi
    if [[ "${MCP_CONFIG_SCOPE}" == "project" ]] && [[ -n "${MCP_PROJECT_ROOT}" ]] && is_claude_code_installed; then
        add_mcp_client "Claude Code (Project)" "${MCP_PROJECT_ROOT}/.mcp.json" "json" "local"
    fi

    # Claude Desktop has only a user-scoped configuration file, so it must not
    # appear after the user selected project-only setup.
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]]; then
        local claude_desktop_config=""
        if [[ "${os}" == "macos" ]]; then
            claude_desktop_config="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
            if [[ -d "${HOME}/Library/Application Support/Claude" ]] || [[ -f "${claude_desktop_config}" ]]; then
                add_mcp_client "Claude Desktop" "${claude_desktop_config}" "json" "global"
            fi
        elif [[ "${os}" == "linux" ]]; then
            claude_desktop_config="${HOME}/.config/Claude/claude_desktop_config.json"
            if [[ -d "${HOME}/.config/Claude" ]] || [[ -f "${claude_desktop_config}" ]]; then
                add_mcp_client "Claude Desktop" "${claude_desktop_config}" "json" "global"
            fi
        fi
    fi

    # Cursor - ~/.cursor/mcp.json for global, .cursor/mcp.json for project
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]] && [[ -d "${HOME}/.cursor" ]]; then
        add_mcp_client "Cursor (Global)" "${HOME}/.cursor/mcp.json" "json" "global"
    fi
    if [[ "${MCP_CONFIG_SCOPE}" == "project" ]] && [[ -n "${MCP_PROJECT_ROOT}" ]] && { [[ -d "${HOME}/.cursor" ]] || [[ -d "${MCP_PROJECT_ROOT}/.cursor" ]] || command -v cursor >/dev/null 2>&1; }; then
        add_mcp_client "Cursor (Project)" "${MCP_PROJECT_ROOT}/.cursor/mcp.json" "json" "local"
    fi

    # Windsurf (Codeium) - ~/.codeium/windsurf/mcp_config.json
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]] && { [[ -d "${HOME}/.codeium/windsurf" ]] || [[ -d "${HOME}/.codeium" ]]; }; then
        add_mcp_client "Windsurf" "${HOME}/.codeium/windsurf/mcp_config.json" "json" "global"
    fi

    # VS Code - check for VS Code installation
    local vscode_installed=false
    if command_exists code; then
        vscode_installed=true
    elif [[ "${os}" == "macos" && -d "/Applications/Visual Studio Code.app" ]]; then
        vscode_installed=true
    elif [[ "${os}" == "linux" && -d "${HOME}/.vscode" ]]; then
        vscode_installed=true
    fi

    if [[ "${vscode_installed}" == "true" && "${MCP_CONFIG_SCOPE}" == "project" && -n "${MCP_PROJECT_ROOT}" ]]; then
        add_mcp_client "VS Code (Project)" "${MCP_PROJECT_ROOT}/.vscode/mcp.json" "json" "local"
    fi

    # Codex (OpenAI) supports both user and trusted project config layers.
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]] && is_codex_user_installed; then
        add_mcp_client "Codex (User)" "${HOME}/.codex/config.toml" "toml" "global"
    fi
    if [[ "${MCP_CONFIG_SCOPE}" == "project" ]] && [[ -n "${MCP_PROJECT_ROOT}" ]] && is_codex_installed; then
        add_mcp_client "Codex (Project)" "${MCP_PROJECT_ROOT}/.codex/config.toml" "toml" "local"
    fi

    # Goose - ~/.config/goose/config.yaml (YAML format!)
    if [[ "${MCP_CONFIG_SCOPE}" != "project" ]] && [[ -d "${HOME}/.config/goose" ]]; then
        add_mcp_client "Goose" "${HOME}/.config/goose/config.yaml" "yaml" "global"
    fi

    # Detection is informational: no available client is a valid result that
    # the caller handles, rather than a failure under the installer's strict
    # shell mode.
    return 0
}

# Get list of detected client names for display
get_detected_client_names() {
    for entry in ${MCP_CLIENT_LIST[@]+"${MCP_CLIENT_LIST[@]}"}; do
        echo "${entry}" | cut -d'|' -f1
    done | sort
}

# Find client entry by name
find_client_entry() {
    local name="$1"

    # Bash 3 on macOS can treat an empty array expansion as unset under
    # `set -u`; no detected clients is an expected lookup miss.
    if [[ -z "${MCP_CLIENT_LIST[*]:-}" ]]; then
        return 1
    fi

    for entry in ${MCP_CLIENT_LIST[@]+"${MCP_CLIENT_LIST[@]}"}; do
        local entry_name
        entry_name=$(echo "${entry}" | cut -d'|' -f1)
        if [[ "${entry_name}" == "${name}" ]]; then
            echo "${entry}"
            return 0
        fi
    done
    return 1
}

# Get config path for a client
get_client_config_path() {
    local client="$1"
    local entry
    entry=$(find_client_entry "${client}")
    if [[ -n "${entry}" ]]; then
        echo "${entry}" | cut -d'|' -f2
    fi
}

# Get config format for a client (json or yaml)
get_client_config_format() {
    local client="$1"
    local entry
    entry=$(find_client_entry "${client}")
    if [[ -n "${entry}" ]]; then
        echo "${entry}" | cut -d'|' -f3
    fi
}

# Get config scope for a client (global or local)
get_client_config_scope() {
    local client="$1"
    local entry
    entry=$(find_client_entry "${client}")
    if [[ -n "${entry}" ]]; then
        echo "${entry}" | cut -d'|' -f4
    fi
}

# Check if a client config file already has auto-mobile configured
client_has_auto_mobile() {
    local client="$1"
    local config_path
    config_path=$(get_client_config_path "${client}")
    local format
    format=$(get_client_config_format "${client}")

    if [[ ! -f "${config_path}" ]]; then
        return 1
    fi

    if [[ "${format}" == "toml" ]]; then
        grep -q '\[mcp_servers.auto-mobile\]' "${config_path}" 2>/dev/null
    elif [[ "${format}" == "yaml" ]]; then
        grep -q 'auto-mobile:' "${config_path}" 2>/dev/null
    else
        # JSON - check for "auto-mobile" key in mcpServers
        grep -q '"auto-mobile"' "${config_path}" 2>/dev/null
    fi
}

# Interactive MCP client selection
select_mcp_clients() {
    detect_mcp_clients

    local available_clients
    available_clients=$(get_detected_client_names)

    if [[ -z "${available_clients}" && ( "${MCP_CONFIG_SCOPE}" == "project" || "${CLAUDE_CLI_INSTALLED}" != "true" ) ]]; then
        log_warn "No MCP clients detected. Manual configuration may be required."
        return 1
    fi

    # Check which clients already have auto-mobile configured
    local clients_with_auto_mobile=()
    local clients_without_auto_mobile=()

    while IFS= read -r client; do
        if client_has_auto_mobile "${client}"; then
            clients_with_auto_mobile+=("${client}")
        else
            clients_without_auto_mobile+=("${client}")
        fi
    done <<< "${available_clients}"

    gum style --bold "Detected MCP Clients:"
    echo ""

    # Show what's detected with their config paths and auto-mobile status
    while IFS= read -r client; do
        local path
        path=$(get_client_config_path "${client}")
        local status_marker=""
        if [[ -f "${path}" ]]; then
            if client_has_auto_mobile "${client}"; then
                status_marker=" (auto-mobile configured)"
            else
                status_marker=" (config exists)"
            fi
        fi
        gum style --faint "  ${client}: ${path}${status_marker}"
    done <<< "${available_clients}"

    echo ""

    # If some clients already have auto-mobile, offer different options
    if [[ ${#clients_with_auto_mobile[@]} -gt 0 ]]; then
        local action_choice
        action_choice=$(gum choose \
            "Leave existing configurations" \
            "Update existing configurations to use @latest" \
            "Configure new clients only" \
            --header "Some clients already have auto-mobile configured:")

        case "${action_choice}" in
            "Leave existing configurations")
                log_info "Keeping existing configurations unchanged."
                return 1
                ;;
            "Update existing configurations to use @latest")
                # Select all clients that have auto-mobile for update
                SELECTED_MCP_CLIENTS=(${clients_with_auto_mobile[@]+"${clients_with_auto_mobile[@]}"})
                log_info "Will update ${#SELECTED_MCP_CLIENTS[@]} existing configuration(s)"
                return 0
                ;;
            "Configure new clients only")
                if [[ ${#clients_without_auto_mobile[@]} -eq 0 ]]; then
                    log_info "All detected clients already have auto-mobile configured."
                    return 1
                fi
                # Fall through to select from unconfigured clients
                available_clients=$(printf '%s\n' "${clients_without_auto_mobile[@]}")
                ;;
            *)
                log_info "No action selected. Skipping MCP configuration."
                return 1
                ;;
        esac
    fi

    echo ""
    gum style --italic --foreground 243 "Press SPACE to select/deselect, ENTER to confirm, ESC to skip"
    echo ""

    # Multi-select with gum choose
    # Use filter for better UX - it allows typing to filter and space to select
    local selected
    selected=$(printf '%s\n' "${available_clients}" | gum filter --no-limit --placeholder "Type to filter, SPACE to select..." --header "Select clients to configure:")

    if [[ -z "${selected}" ]]; then
        log_info "No clients selected. Skipping MCP configuration."
        return 1
    fi

    # Store selected clients
    SELECTED_MCP_CLIENTS=()
    while IFS= read -r client; do
        if [[ -n "${client}" ]]; then
            SELECTED_MCP_CLIENTS+=("${client}")
        fi
    done <<< "${selected}"

    if [[ ${#SELECTED_MCP_CLIENTS[@]} -eq 0 ]]; then
        log_info "No clients selected. Skipping MCP configuration."
        return 1
    fi

    log_info "Selected ${#SELECTED_MCP_CLIENTS[@]} client(s) for configuration"
    return 0
}

# ============================================================================
# JSON/YAML Configuration Management
# ============================================================================

# Validate JSON file
validate_json() {
    local file="$1"

    if [[ ! -f "${file}" ]]; then
        return 1
    fi

    if command_exists python3; then
        python3 -c "import json; json.load(open('${file}'))" 2>/dev/null
        return $?
    elif command_exists jq; then
        jq empty "${file}" 2>/dev/null
        return $?
    fi

    return 1
}

# Read existing mcpServers from a JSON config or return empty object
get_existing_mcp_servers() {
    local config_file="$1"

    if [[ ! -f "${config_file}" ]]; then
        echo "{}"
        return 0
    fi

    if ! validate_json "${config_file}"; then
        echo "{}"
        return 1
    fi

    if command_exists python3; then
        python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print(json.dumps(data.get("mcpServers", {})))
except Exception:
    print("{}")
' "${config_file}"
    elif command_exists jq; then
        jq -r '.mcpServers // {}' "${config_file}" 2>/dev/null || echo "{}"
    else
        echo "{}"
    fi
}

# Create backup of config file
backup_config() {
    local config_file="$1"

    if [[ ! -f "${config_file}" ]]; then
        return 0
    fi

    if [[ -z "${BACKUP_TIMESTAMP}" ]]; then
        BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    fi

    execute "Create backup directory" mkdir -p "${BACKUP_DIR}"

    local backup_name
    backup_name=$(basename "${config_file}")
    local backup_path="${BACKUP_DIR}/${backup_name}.${BACKUP_TIMESTAMP}"

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Backup ${config_file} to ${backup_path}")
        log_info "[DRY-RUN] Would backup ${config_file} to ${backup_path}"
    else
        cp "${config_file}" "${backup_path}"
        log_info "Backed up to ${backup_path}"
    fi
}

# Merge auto-mobile config into existing JSON config
merge_mcp_config() {
    local config_file="$1"
    local auto_mobile_config="$2"  # JSON string for auto-mobile server

    # Handle case where file doesn't exist
    if [[ ! -f "${config_file}" ]]; then
        echo "{\"mcpServers\":{\"auto-mobile\":${auto_mobile_config}}}"
        return 0
    fi

    # Handle invalid JSON
    if ! validate_json "${config_file}"; then
        log_warn "Invalid JSON in ${config_file}, will create fresh config"
        echo "{\"mcpServers\":{\"auto-mobile\":${auto_mobile_config}}}"
        return 0
    fi

    if command_exists python3; then
        python3 -c '
import json, sys

config_file = sys.argv[1]
new_auto_mobile = json.loads(sys.argv[2])

try:
    with open(config_file) as f:
        existing = json.load(f)
except Exception:
    existing = {}

# Ensure mcpServers exists
if "mcpServers" not in existing:
    existing["mcpServers"] = {}

# Check if auto-mobile already exists
if "auto-mobile" in existing["mcpServers"]:
    print("INFO:auto-mobile already configured, will be updated", file=sys.stderr)

# Merge (overwrites existing auto-mobile)
existing["mcpServers"]["auto-mobile"] = new_auto_mobile

sys.stdout.buffer.write(json.dumps(existing, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")
' "${config_file}" "${auto_mobile_config}"
    elif command_exists jq; then
        jq --argjson new "${auto_mobile_config}" '.mcpServers["auto-mobile"] = $new' "${config_file}"
    else
        log_error "Neither python3 nor jq available for JSON manipulation"
        return 1
    fi
}

# Merge auto-mobile config into existing TOML config (for Codex)
merge_toml_config() {
    local config_file="$1"
    local auto_mobile_toml="$2"  # TOML string for auto-mobile server

    # Handle case where file doesn't exist
    if [[ ! -f "${config_file}" ]]; then
        echo "${auto_mobile_toml}"
        return 0
    fi

    if command_exists python3; then
        python3 -c '
import sys

config_file = sys.argv[1]
new_toml = sys.argv[2]

try:
    with open(config_file) as f:
        existing = f.read()
except Exception:
    existing = ""

# Check if auto-mobile already configured
if "[mcp_servers.auto-mobile]" in existing:
    print("INFO:auto-mobile already configured in TOML, will be updated", file=sys.stderr)
    # Remove existing auto-mobile section (lines from [mcp_servers.auto-mobile] until next section or EOF)
    lines = existing.split("\n")
    result = []
    skip = False
    for line in lines:
        stripped = line.strip()
        # Start skipping when we hit the exact auto-mobile section header
        if stripped == "[mcp_servers.auto-mobile]":
            skip = True
            continue
        # Continue skipping auto-mobile subsections (e.g. [mcp_servers.auto-mobile.env])
        if skip and stripped.startswith("[mcp_servers.auto-mobile."):
            continue
        # Stop skipping when we hit any other section header
        # This correctly preserves [mcp_servers.auto-mobile-dev] etc.
        if skip and stripped.startswith("["):
            skip = False
        if not skip:
            result.append(line)
    existing = "\n".join(result).strip()

# Append new config
if existing:
    print(existing + "\n\n" + new_toml)
else:
    print(new_toml)
' "${config_file}" "${auto_mobile_toml}"
    else
        log_error "python3 required for TOML manipulation"
        return 1
    fi
}

# Show diff between old and new config (uses colored diff)
show_config_diff() {
    local old_content="$1"
    local new_content="$2"
    local config_path="$3"

    if [[ -z "${old_content}" ]] || [[ "${old_content}" == "{}" ]]; then
        show_new_file "${new_content}" "${config_path}"
        return 0
    fi

    # Check if content is the same
    if [[ "${old_content}" == "${new_content}" ]]; then
        log_info "No changes needed for ${config_path}"
        return 0
    fi

    show_colored_diff "${old_content}" "${new_content}" "${config_path}"
}

# Generate auto-mobile MCP server config based on preset
generate_auto_mobile_config() {
    local preset="${1:-minimal}"
    local android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

    # Build env object parts
    local env_parts=""
    if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
        env_parts="\"BUN_CONFIG_REGISTRY\":\"${BUN_CONFIG_REGISTRY}\""
    fi

    local args='"@kaeawc/auto-mobile@latest"'
    case "${preset}" in
        development)
            args='"@kaeawc/auto-mobile@latest","--debug","--debug-perf"'
            if [[ -n "${android_home}" && "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
                env_parts="${env_parts:+${env_parts},}\"ANDROID_HOME\":\"${android_home}\""
            fi
            ;;
    esac

    if [[ -n "${env_parts}" ]]; then
        echo "{\"command\":\"bunx\",\"args\":[${args}],\"env\":{${env_parts}}}"
    else
        echo "{\"command\":\"bunx\",\"args\":[${args}]}"
    fi
}

# Generate auto-mobile MCP server config in TOML format (for Codex)
generate_auto_mobile_config_toml() {
    local preset="${1:-minimal}"
    local android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

    local args='["@kaeawc/auto-mobile@latest"]'
    local has_env=false
    case "${preset}" in
        development)
            args='["@kaeawc/auto-mobile@latest", "--debug", "--debug-perf"]'
            if [[ -n "${android_home}" && "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
                has_env=true
            fi
            ;;
    esac

    if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
        has_env=true
    fi

    cat << EOF
[mcp_servers.auto-mobile]
command = "bunx"
args = ${args}
EOF

    if [[ "${has_env}" == "true" ]]; then
        echo ""
        echo "[mcp_servers.auto-mobile.env]"
        if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
            echo "BUN_CONFIG_REGISTRY = \"${BUN_CONFIG_REGISTRY}\""
        fi
        if [[ "${preset}" == "development" && -n "${android_home}" && "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
            echo "ANDROID_HOME = \"${android_home}\""
        fi
    fi
}

# Check if yq is installed
is_yq_installed() {
    command_exists yq
}

# Install yq for YAML processing
install_yq() {
    local os
    os=$(detect_os)

    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        if ! gum confirm "yq is required for YAML configuration. Install yq now?"; then
            log_info "Skipped yq installation"
            return 1
        fi
    fi

    if [[ "${os}" == "macos" ]] && command_exists brew; then
        if ! run_bounded_install "Installing yq via Homebrew" brew install yq; then
            log_error "Failed to install yq"
            return 1
        fi
    elif command_exists go; then
        if ! run_bounded_install "Installing yq via go install" go install github.com/mikefarah/yq/v4@latest; then
            log_error "Failed to install yq"
            return 1
        fi
    else
        # Try direct binary download
        local arch
        arch=$(detect_arch)
        local yq_binary="yq_${os}_${arch}"
        local yq_url="https://github.com/mikefarah/yq/releases/latest/download/${yq_binary}"

        local install_dir="${HOME}/.local/bin"
        mkdir -p "${install_dir}"

        if command_exists curl; then
            if ! run_spinner "Downloading yq" curl -fsSL "${yq_url}" -o "${install_dir}/yq"; then
                log_error "Failed to download yq"
                return 1
            fi
        elif command_exists wget; then
            if ! run_spinner "Downloading yq" wget -qO "${install_dir}/yq" "${yq_url}"; then
                log_error "Failed to download yq"
                return 1
            fi
        else
            log_error "curl or wget required to download yq"
            return 1
        fi

        chmod +x "${install_dir}/yq"
        export PATH="${install_dir}:${PATH}"
    fi

    if command_exists yq; then
        log_info "yq installed: $(yq --version 2>&1 | head -1)"
        return 0
    else
        log_error "yq installation failed"
        return 1
    fi
}

# Ensure yq is available, installing if needed
ensure_yq() {
    if is_yq_installed; then
        return 0
    fi
    install_yq
}

# Generate auto-mobile MCP server config in YAML format (for Goose)
generate_auto_mobile_config_yaml() {
    local preset="${1:-minimal}"
    local android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

    local has_env=false
    local args_block='      - "@kaeawc/auto-mobile@latest"'
    case "${preset}" in
        development)
            args_block='      - "@kaeawc/auto-mobile@latest"
      - "--debug"
      - "--debug-perf"'
            if [[ -n "${android_home}" && "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
                has_env=true
            fi
            ;;
    esac

    if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
        has_env=true
    fi

    cat << EOF
extensions:
  auto-mobile:
    name: auto-mobile
    type: stdio
    enabled: true
    cmd: bunx
    args:
${args_block}
EOF

    if [[ "${has_env}" == "true" ]]; then
        echo "    env:"
        if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
            echo "      BUN_CONFIG_REGISTRY: \"${BUN_CONFIG_REGISTRY}\""
        fi
        if [[ "${preset}" == "development" && -n "${android_home}" && "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
            echo "      ANDROID_HOME: \"${android_home}\""
        fi
    fi
}

# Merge auto-mobile config into existing YAML config (for Goose)
merge_mcp_config_yaml() {
    local config_file="$1"
    local auto_mobile_yaml="$2"

    # Handle case where file doesn't exist
    if [[ ! -f "${config_file}" ]]; then
        echo "${auto_mobile_yaml}"
        return 0
    fi

    # Use yq to merge the configs
    if ! command_exists yq; then
        log_error "yq required for YAML configuration"
        return 1
    fi

    # Check if auto-mobile already exists in the config
    if yq -e '.extensions.auto-mobile' "${config_file}" &>/dev/null; then
        log_info "auto-mobile already configured in YAML, will be updated"
    fi

    # Create a temp file with the new auto-mobile config
    local temp_new
    temp_new=$(mktemp)
    echo "${auto_mobile_yaml}" > "${temp_new}"

    # Merge: existing config + new auto-mobile extension
    # This overwrites .extensions.auto-mobile with the new config
    local merged
    merged=$(yq eval-all 'select(fileIndex == 0) * select(fileIndex == 1)' "${config_file}" "${temp_new}" 2>/dev/null)

    rm -f "${temp_new}"

    if [[ -z "${merged}" ]]; then
        log_error "Failed to merge YAML configs"
        return 1
    fi

    echo "${merged}"
}

# Update a single MCP client's configuration
update_mcp_client_config() {
    local client_name="$1"
    local config_path="$2"
    local auto_mobile_config="$3"
    local format="${4:-json}"

    log_info "Configuring ${client_name}..."

    # Read existing config
    local existing_content=""
    if [[ -f "${config_path}" ]]; then
        existing_content=$(cat "${config_path}" 2>/dev/null || echo "")
    fi

    # Generate merged config based on format
    local new_content
    if [[ "${format}" == "yaml" ]]; then
        if ! new_content=$(merge_mcp_config_yaml "${config_path}" "${auto_mobile_config}"); then
            log_error "Failed to generate YAML config for ${client_name}"
            return 1
        fi
    elif [[ "${format}" == "toml" ]]; then
        if ! new_content=$(merge_toml_config "${config_path}" "${auto_mobile_config}"); then
            log_error "Failed to generate TOML config for ${client_name}"
            return 1
        fi
    else
        if ! new_content=$(merge_mcp_config "${config_path}" "${auto_mobile_config}"); then
            log_error "Failed to generate config for ${client_name}"
            return 1
        fi
    fi

    # Check if there are any changes needed
    if [[ "${existing_content}" == "${new_content}" ]]; then
        log_info "No changes needed for ${client_name}"
        return 0
    fi

    # Detect npx → bunx migration and show clear messaging
    if echo "${existing_content}" | grep -qE '"npx"|command = "npx"|cmd: npx'; then
        echo ""
        printf '%b[MIGRATION]%b %s config uses npx — updating to bunx.\n' "${BOLD}" "${RESET}" "${client_name}"
        printf '  AutoMobile now runs exclusively on Bun for a single, consistent runtime.\n'
        printf '  This changes the MCP server command from npx to bunx.\n'
        echo ""
    fi

    # Show diff
    show_config_diff "${existing_content}" "${new_content}" "${config_path}"

    # Reset terminal after colored output
    printf '%s' "${RESET}"

    # A dry run must never create a config directory, a backup, or the config
    # file itself. Keep this guard before every filesystem mutation below.
    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Configure ${client_name}: ${config_path}")
        log_info "[DRY-RUN] Would configure ${client_name}: ${config_path}"
        return 0
    fi

    # Both interactive and non-interactive setup can create new scoped config
    # files (notably .codex/config.toml). Calculate the parent now, but create
    # it only after non-interactive selection or interactive confirmation.
    local parent_dir
    parent_dir=$(dirname "${config_path}")

    # In non-interactive mode, just apply
    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        if [[ ! -d "${parent_dir}" ]]; then
            mkdir -p "${parent_dir}"
        fi
        backup_config "${config_path}"
        printf '%s\n' "${new_content}" > "${config_path}"
        log_info "${client_name} configured successfully"
        CHANGES_MADE=true
        return 0
    fi

    # Confirm with user
    local confirm_prompt
    if [[ -n "${existing_content}" ]]; then
        confirm_prompt="Apply changes to ${config_path}?"
    else
        confirm_prompt="Create ${config_path}?"
    fi

    if ! gum confirm "${confirm_prompt}"; then
        log_info "Skipping ${client_name} configuration"
        return 0
    fi

    # Backup and write (skip confirmation since we already confirmed above)
    if [[ ! -d "${parent_dir}" ]]; then
        mkdir -p "${parent_dir}"
    fi
    backup_config "${config_path}"

    printf '%s\n' "${new_content}" > "${config_path}"
    log_info "${client_name} configured successfully"
    CHANGES_MADE=true
}

# Configure all selected MCP clients
configure_selected_mcp_clients() {
    if [[ ${#SELECTED_MCP_CLIENTS[@]} -eq 0 ]]; then
        log_info "No MCP clients selected for configuration"
        return 0
    fi

    # The selected installation path determines the MCP configuration. Do not
    # offer debug flags during an end-user install.
    local config_preset="${PRESET:-minimal}"

    local auto_mobile_config_json
    auto_mobile_config_json=$(generate_auto_mobile_config "${config_preset}")
    local auto_mobile_config_toml
    auto_mobile_config_toml=$(generate_auto_mobile_config_toml "${config_preset}")
    local auto_mobile_config_yaml
    auto_mobile_config_yaml=$(generate_auto_mobile_config_yaml "${config_preset}")

    gum style --bold "Configuring AutoMobile with the ${config_preset} setup"
    echo ""

    for client in ${SELECTED_MCP_CLIENTS[@]+"${SELECTED_MCP_CLIENTS[@]}"}; do
        local config_path
        config_path=$(get_client_config_path "${client}")
        local format
        format=$(get_client_config_format "${client}")

        if [[ "${format}" == "yaml" ]]; then
            # Ensure yq is available for YAML processing
            if ! ensure_yq; then
                log_warn "YAML configuration for ${client} requires yq. Skipping."
                log_info "Manual configuration required for: ${config_path}"
                continue
            fi
            update_mcp_client_config "${client}" "${config_path}" "${auto_mobile_config_yaml}" "yaml"
        elif [[ "${format}" == "toml" ]]; then
            update_mcp_client_config "${client}" "${config_path}" "${auto_mobile_config_toml}" "toml"
        else
            update_mcp_client_config "${client}" "${config_path}" "${auto_mobile_config_json}" "json"
        fi
        echo ""
    done
}

resolve_ide_plugin_url() {
    local url=""

    if command_exists curl; then
        url=$(curl -fsSL "https://api.github.com/repos/kaeawc/auto-mobile/releases/latest" 2>/dev/null \
            | sed -nE 's/.*"browser_download_url": "([^"]*auto-mobile-ide-plugin[^"]*\.zip)".*/\1/p' \
            | head -n 1 || true)
    elif command_exists wget; then
        url=$(wget -qO- "https://api.github.com/repos/kaeawc/auto-mobile/releases/latest" 2>/dev/null \
            | sed -nE 's/.*"browser_download_url": "([^"]*auto-mobile-ide-plugin[^"]*\.zip)".*/\1/p' \
            | head -n 1 || true)
    fi

    echo "${url}"
}

# Return the native installer suffix published for a supported host. Desktop release
# assets deliberately use a stable platform suffix; the installer architecture is
# checked after download before anything is copied to the system.
desktop_app_asset_suffix() {
    local os="$1"
    local arch="$2"

    case "${os}:${arch}" in
        macos:arm64)
            echo "-macos.dmg"
            ;;
        linux:x86_64)
            echo "-linux.deb"
            ;;
        *)
            return 1
            ;;
    esac
}

desktop_app_is_root() {
    [[ "${EUID}" -eq 0 ]]
}

# These predicates intentionally translate command status into availability.
# shellcheck disable=SC2310
desktop_app_privilege_available() {
    desktop_app_is_root || command_exists sudo
}

# Every privileged command status is returned to an explicit caller check.
# shellcheck disable=SC2310
run_desktop_app_privileged() {
    if desktop_app_is_root; then
        "$@"
    elif command_exists sudo; then
        sudo "$@"
    else
        log_error "Administrator privileges are required to install the AutoMobile desktop app."
        return 1
    fi
}

# Missing prerequisites are an expected false predicate, not a fatal command.
# shellcheck disable=SC2310
desktop_app_prerequisites_available() {
    local os="$1"

    if ! desktop_app_privilege_available; then
        return 1
    fi

    case "${os}" in
        macos)
            command_exists hdiutil && command_exists lipo && command_exists ditto
            ;;
        linux)
            command_exists dpkg-deb && (command_exists apt-get || command_exists dpkg)
            ;;
        *)
            return 1
            ;;
    esac
}

# Detach before removing the temporary directory. A failed detach is retried by
# the process-wide EXIT cleanup and must not turn a successful app copy into an
# installation failure.
cleanup_desktop_app_installer() {
    if [[ -n "${DESKTOP_APP_MOUNT_DIR}" ]]; then
        if hdiutil detach "${DESKTOP_APP_MOUNT_DIR}" >/dev/null 2>&1 \
            || hdiutil detach -force "${DESKTOP_APP_MOUNT_DIR}" >/dev/null 2>&1; then
            DESKTOP_APP_MOUNT_DIR=""
        fi
    fi

    if [[ -n "${DESKTOP_APP_TEMP_DIR}" && -z "${DESKTOP_APP_MOUNT_DIR}" ]]; then
        rm -rf -- "${DESKTOP_APP_TEMP_DIR}"
        DESKTOP_APP_TEMP_DIR=""
    fi
    return 0
}

# Recover an interrupted bundle swap before removing its staging directory. All
# paths are tracked globally because this function also runs from the process-
# wide EXIT/TERM cleanup hook.
# shellcheck disable=SC2310
cleanup_macos_desktop_app_replacement() {
    local preserve_staging=false

    if [[ "${DESKTOP_APP_REPLACEMENT_COMPLETE}" != "true" ]] \
        && [[ -n "${DESKTOP_APP_REPLACEMENT_PREVIOUS}" ]] \
        && run_desktop_app_privileged test ! -e "${DESKTOP_APP_REPLACEMENT_TARGET}" \
        && run_desktop_app_privileged test -e "${DESKTOP_APP_REPLACEMENT_PREVIOUS}"; then
        if ! run_desktop_app_privileged mv -- \
            "${DESKTOP_APP_REPLACEMENT_PREVIOUS}" "${DESKTOP_APP_REPLACEMENT_TARGET}"; then
            preserve_staging=true
            log_error "Could not restore the previous AutoMobile.app. It remains at ${DESKTOP_APP_REPLACEMENT_PREVIOUS}."
        fi
    fi

    if [[ "${preserve_staging}" != "true" && -n "${DESKTOP_APP_REPLACEMENT_STAGING_DIR}" ]]; then
        run_desktop_app_privileged rm -rf -- "${DESKTOP_APP_REPLACEMENT_STAGING_DIR}" || true
    fi
    if [[ -n "${DESKTOP_APP_REPLACEMENT_LOCK_DIR}" ]]; then
        run_desktop_app_privileged rm -f -- "${DESKTOP_APP_REPLACEMENT_LOCK_DIR}/owner.pid" || true
        run_desktop_app_privileged rmdir "${DESKTOP_APP_REPLACEMENT_LOCK_DIR}" || true
    fi

    DESKTOP_APP_REPLACEMENT_LOCK_DIR=""
    if [[ "${preserve_staging}" != "true" ]]; then
        DESKTOP_APP_REPLACEMENT_TARGET=""
        DESKTOP_APP_REPLACEMENT_PREVIOUS=""
        DESKTOP_APP_REPLACEMENT_COMPLETE=false
        DESKTOP_APP_REPLACEMENT_STAGING_DIR=""
    fi
    return 0
}

recover_stale_macos_desktop_app_swap() {
    local target_parent="$1" target_app="$2" swap_dir previous_app
    [[ -e "${target_app}" ]] && return 0
    while IFS= read -r swap_dir; do
        [[ -n "${swap_dir}" ]] || continue
        previous_app="${swap_dir}/Previous-AutoMobile.app"
        if run_desktop_app_privileged test -e "${previous_app}"; then
            if run_desktop_app_privileged mv -- "${previous_app}" "${target_app}"; then
                log_warn "Recovered the previous AutoMobile.app after an interrupted installation."
            else
                log_error "Could not recover the previous AutoMobile.app from ${previous_app}."
                return 1
            fi
            run_desktop_app_privileged rm -rf -- "${swap_dir}" || return 1
            return 0
        fi
        run_desktop_app_privileged rm -rf -- "${swap_dir}" || return 1
    done < <(run_desktop_app_privileged find "${target_parent}" -maxdepth 1 -type d -name '.automobile-install.*' -print 2>/dev/null)
}

acquire_macos_desktop_app_lock() {
    local lock_dir="$1" target_parent="$2" target_app="$3" owner_pid
    if run_desktop_app_privileged mkdir "${lock_dir}" 2>/dev/null; then
        printf '%s\n' "${BASHPID}" | run_desktop_app_privileged tee "${lock_dir}/owner.pid" >/dev/null
        return 0
    fi
    if ! owner_pid=$(run_desktop_app_privileged cat "${lock_dir}/owner.pid" 2>/dev/null) \
        || [[ ! "${owner_pid}" =~ ^[0-9]+$ ]] \
        || run_desktop_app_privileged kill -0 "${owner_pid}" 2>/dev/null; then
        return 1
    fi
    log_warn "Reclaiming stale AutoMobile desktop installation lock."
    run_desktop_app_privileged rm -rf -- "${lock_dir}" || return 1
    recover_stale_macos_desktop_app_swap "${target_parent}" "${target_app}" || return 1
    run_desktop_app_privileged mkdir "${lock_dir}" || return 1
    printf '%s\n' "${BASHPID}" | run_desktop_app_privileged tee "${lock_dir}/owner.pid" >/dev/null
}

# Copy into a sibling staging directory, then swap the bundle into place. This
# keeps an existing installation recoverable if the replacement move fails.
# shellcheck disable=SC2310
install_macos_desktop_app_bundle() {
    local source_app="$1"
    local target_app="${2:-/Applications/AutoMobile.app}"
    local target_parent lock_dir staging_dir staged_app previous_app
    target_parent=$(dirname "${target_app}")
    lock_dir="${target_parent}/.automobile-install.lock"
    DESKTOP_APP_REPLACEMENT_TARGET="${target_app}"
    DESKTOP_APP_REPLACEMENT_LOCK_DIR="${lock_dir}"
    DESKTOP_APP_REPLACEMENT_COMPLETE=false
    if ! acquire_macos_desktop_app_lock "${lock_dir}" "${target_parent}" "${target_app}"; then
        DESKTOP_APP_REPLACEMENT_LOCK_DIR=""
        DESKTOP_APP_REPLACEMENT_TARGET=""
        log_error "Another AutoMobile desktop app installation is already in progress."
        return 1
    fi
    if ! staging_dir=$(run_desktop_app_privileged mktemp -d "${target_parent}/.automobile-install.XXXXXX"); then
        cleanup_macos_desktop_app_replacement
        return 1
    fi
    DESKTOP_APP_REPLACEMENT_STAGING_DIR="${staging_dir}"
    staged_app="${staging_dir}/AutoMobile.app"
    previous_app="${staging_dir}/Previous-AutoMobile.app"
    DESKTOP_APP_REPLACEMENT_PREVIOUS="${previous_app}"

    if ! run_desktop_app_privileged ditto "${source_app}" "${staged_app}"; then
        cleanup_macos_desktop_app_replacement
        return 1
    fi

    if [[ -e "${target_app}" ]]; then
        if ! run_desktop_app_privileged mv -- "${target_app}" "${previous_app}"; then
            cleanup_macos_desktop_app_replacement
            return 1
        fi
    fi

    if ! run_desktop_app_privileged mv -- "${staged_app}" "${target_app}"; then
        cleanup_macos_desktop_app_replacement
        return 1
    fi

    DESKTOP_APP_REPLACEMENT_COMPLETE=true
    cleanup_macos_desktop_app_replacement
}

# `detect_os` intentionally treats Git Bash as Linux for the existing developer
# environment setup. Keep the desktop installer separate so it never mistakes a
# Windows host for a Linux .deb target.
detect_desktop_app_os() {
    case "$(uname -s)" in
        Darwin*)
            echo "macos"
            ;;
        Linux*)
            echo "linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "windows"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Under Rosetta, uname reports the translated x86_64 process architecture even
# on Apple Silicon. The published desktop app is arm64-only, so select it from
# the native hardware signal instead.
# This is an availability probe: unsupported sysctl keys are an expected miss.
# shellcheck disable=SC2310
detect_desktop_app_arch() {
    if [[ "$(detect_desktop_app_os)" == "macos" ]] \
        && [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" == "1" ]]; then
        echo "arm64"
    else
        detect_arch
    fi
}

# Extract the matching asset URL from the GitHub releases API response without
# relying on a line-oriented JSON parser. Python is already a required installer
# dependency for MCP configuration; jq remains a useful fallback for minimal hosts.
# Each capability branch explicitly returns the selected parser's status.
# shellcheck disable=SC2310
resolve_desktop_app_release_asset() {
    local release_json="$1"
    local suffix="$2"

    if command_exists python3; then
        printf '%s' "${release_json}" | python3 -c '
import json
import sys

release = json.load(sys.stdin)
suffix = sys.argv[1]
for asset in release.get("assets", []):
    name = asset.get("name", "")
    url = asset.get("browser_download_url", "")
    if name.endswith(suffix) and url:
        print(url)
        break
' "${suffix}"
        return $?
    fi

    if command_exists jq; then
        printf '%s' "${release_json}" | jq -r --arg suffix "${suffix}" \
            '.assets[] | select(.name | endswith($suffix)) | .browser_download_url' | head -n 1
        return 0
    fi

    log_error "python3 or jq is required to read GitHub release metadata."
    return 1
}

# Each capability branch explicitly returns the selected downloader's status.
# shellcheck disable=SC2310
fetch_latest_desktop_app_release() {
    local api_url="https://api.github.com/repos/kaeawc/auto-mobile/releases/latest"

    if command_exists curl; then
        curl --fail --show-error --silent --location "${api_url}"
    elif command_exists wget; then
        wget --quiet -O- "${api_url}"
    else
        log_error "curl or wget is required to fetch the AutoMobile desktop app release."
        return 1
    fi
}

# A missing tool or mismatched architecture is an expected false predicate.
# shellcheck disable=SC2310
desktop_app_deb_architecture_matches_host() {
    local package_path="$1"
    local host_arch="$2"
    local package_arch

    command_exists dpkg-deb || return 1
    package_arch=$(dpkg-deb --field "${package_path}" Architecture 2>/dev/null) || return 1

    case "${host_arch}:${package_arch}" in
        x86_64:amd64)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Installer failures are translated into targeted diagnostics at each branch.
# shellcheck disable=SC2310
install_desktop_app() {
    local os arch suffix
    os=$(detect_desktop_app_os)
    arch=$(detect_desktop_app_arch)
    if ! suffix=$(desktop_app_asset_suffix "${os}" "${arch}"); then
        log_error "The AutoMobile desktop app does not support this host (${os}/${arch})."
        return 1
    fi
    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Download the latest AutoMobile desktop app for ${os}/${arch} from GitHub Releases")
        log_info "[DRY-RUN] Would install the latest AutoMobile desktop app for ${os}/${arch}"
        return 0
    fi

    # An unavailable prerequisite is translated into the installer diagnostic below.
    # shellcheck disable=SC2310
    if ! desktop_app_prerequisites_available "${os}"; then
        log_error "This host is missing the system tools or administrator privileges required to install the AutoMobile desktop app."
        return 1
    fi

    local release_json asset_url
    if ! release_json=$(fetch_latest_desktop_app_release); then
        log_error "Failed to fetch the latest AutoMobile GitHub release."
        return 1
    fi
    if ! asset_url=$(resolve_desktop_app_release_asset "${release_json}" "${suffix}"); then
        return 1
    fi
    if [[ -z "${asset_url}" ]]; then
        log_error "The latest AutoMobile release has no desktop installer for ${os}/${arch}."
        return 1
    fi

    local temp_dir installer_path
    temp_dir=$(mktemp -d)
    DESKTOP_APP_TEMP_DIR="${temp_dir}"
    installer_path="${temp_dir}/AutoMobile${suffix}"
    if ! download_file "${asset_url}" "${installer_path}"; then
        log_error "Failed to download the AutoMobile desktop app from ${asset_url}"
        cleanup_desktop_app_installer
        return 1
    fi

    case "${os}" in
        macos)
            local mount_dir app_path app_binary app_arches
            mount_dir="${temp_dir}/mount"
            mkdir -p "${mount_dir}"
            if ! hdiutil attach -nobrowse -readonly -mountpoint "${mount_dir}" "${installer_path}" >/dev/null; then
                log_error "Could not mount the downloaded AutoMobile disk image."
                cleanup_desktop_app_installer
                return 1
            fi
            DESKTOP_APP_MOUNT_DIR="${mount_dir}"
            app_path=$(find "${mount_dir}" -maxdepth 1 -name 'AutoMobile.app' -type d -print -quit)
            app_binary="${app_path}/Contents/MacOS/AutoMobile"
            if [[ -z "${app_path}" || ! -x "${app_binary}" ]]; then
                log_error "The disk image does not contain a valid AutoMobile.app bundle."
                cleanup_desktop_app_installer
                return 1
            fi
            app_arches=$(lipo -archs "${app_binary}" 2>/dev/null || true)
            if [[ " ${app_arches} " != *" ${arch} "* ]]; then
                log_error "Downloaded desktop app architecture (${app_arches:-unknown}) does not match this Mac (${arch})."
                cleanup_desktop_app_installer
                return 1
            fi
            # Bundle replacement failure is translated into the installer diagnostic below.
            # shellcheck disable=SC2310
            if ! install_macos_desktop_app_bundle "${app_path}"; then
                log_error "Failed to install AutoMobile.app in /Applications."
                cleanup_desktop_app_installer
                return 1
            fi
            cleanup_desktop_app_installer
            log_info "AutoMobile desktop app installed to /Applications/AutoMobile.app"
            ;;
        linux)
            if ! desktop_app_deb_architecture_matches_host "${installer_path}" "${arch}"; then
                log_error "Downloaded desktop app package does not match this Linux host (${arch})."
                cleanup_desktop_app_installer
                return 1
            fi
            if command_exists apt-get; then
                # Package-manager failure is translated into the installer diagnostic below.
                # shellcheck disable=SC2310
                if ! run_desktop_app_privileged apt-get install -y "${installer_path}"; then
                    log_error "Failed to install the AutoMobile desktop app package."
                    cleanup_desktop_app_installer
                    return 1
                fi
            elif command_exists dpkg; then
                # Package-manager failure is translated into the installer diagnostic below.
                # shellcheck disable=SC2310
                if ! run_desktop_app_privileged dpkg --install "${installer_path}"; then
                    log_error "Failed to install the AutoMobile desktop app package."
                    cleanup_desktop_app_installer
                    return 1
                fi
            else
                log_error "apt-get or dpkg is required to install the downloaded .deb package."
                cleanup_desktop_app_installer
                return 1
            fi
            log_info "AutoMobile desktop app installed."
            ;;
    esac

    cleanup_desktop_app_installer
    CHANGES_MADE=true
}

# Unsupported hosts intentionally suppress this optional prompt.
# shellcheck disable=SC2310
offer_desktop_app_install() {
    [[ "${INSTALL_DESKTOP_APP}" == "true" ]] && return 0

    local os arch
    os=$(detect_desktop_app_os)
    arch=$(detect_desktop_app_arch)
    if ! desktop_app_asset_suffix "${os}" "${arch}" >/dev/null; then
        log_info "AutoMobile desktop app is not available for this host (${os}/${arch})."
        return 0
    fi
    # Missing prerequisites intentionally suppress the optional prompt.
    # shellcheck disable=SC2310
    if ! desktop_app_prerequisites_available "${os}"; then
        log_info "AutoMobile desktop app installation prerequisites are not available on this host."
        return 0
    fi

    if gum confirm "Install the native AutoMobile desktop app from the latest GitHub release?" --default=false; then
        INSTALL_DESKTOP_APP=true
    fi
}

detect_ide_plugins_dir() {
    if [[ -n "${ANDROID_STUDIO_PLUGINS_DIR:-}" ]]; then
        echo "${ANDROID_STUDIO_PLUGINS_DIR}"
        return 0
    fi
    if [[ -n "${IDEA_PLUGINS_DIR:-}" ]]; then
        echo "${IDEA_PLUGINS_DIR}"
        return 0
    fi

    local os
    os=$(detect_os)

    if [[ "${os}" == "macos" ]]; then
        local jetbrains_dir="${HOME}/Library/Application Support/JetBrains"
        local google_dir="${HOME}/Library/Application Support/Google"
        local candidate=""

        if [[ -d "${jetbrains_dir}" ]]; then
            candidate=$(find "${jetbrains_dir}" -maxdepth 1 -type d \( -name "IntelliJIdea*" -o -name "AndroidStudio*" \) 2>/dev/null | sort -r | head -n 1 || true)
            if [[ -n "${candidate}" ]]; then
                echo "${candidate}/plugins"
                return 0
            fi
        fi

        if [[ -d "${google_dir}" ]]; then
            candidate=$(find "${google_dir}" -maxdepth 1 -type d -name "AndroidStudio*" 2>/dev/null | sort -r | head -n 1 || true)
            if [[ -n "${candidate}" ]]; then
                echo "${candidate}/plugins"
                return 0
            fi
        fi
    fi

    if [[ "${os}" == "linux" ]]; then
        local jetbrains_dir="${HOME}/.local/share/JetBrains"
        local google_dir="${HOME}/.local/share/Google"
        local candidate=""

        if [[ -d "${jetbrains_dir}" ]]; then
            candidate=$(find "${jetbrains_dir}" -maxdepth 1 -type d \( -name "IntelliJIdea*" -o -name "AndroidStudio*" \) 2>/dev/null | sort -r | head -n 1 || true)
            if [[ -n "${candidate}" ]]; then
                echo "${candidate}/plugins"
                return 0
            fi
        fi

        if [[ -d "${google_dir}" ]]; then
            candidate=$(find "${google_dir}" -maxdepth 1 -type d -name "AndroidStudio*" 2>/dev/null | sort -r | head -n 1 || true)
            if [[ -n "${candidate}" ]]; then
                echo "${candidate}/plugins"
                return 0
            fi
        fi
    fi

    return 1
}

resolve_auto_mobile_command() {
    if [[ -n "${AUTOMOBILE_CLI_PATH:-}" ]]; then
        if [[ ! -x "${AUTOMOBILE_CLI_PATH}" ]]; then
            log_error "AUTOMOBILE_CLI_PATH must point to an executable AutoMobile CLI: ${AUTOMOBILE_CLI_PATH}"
            return 1
        fi
        AUTO_MOBILE_CMD=("${AUTOMOBILE_CLI_PATH}")
        return 0
    fi

    if command_exists bunx; then
        AUTO_MOBILE_CMD=("bunx" "@kaeawc/auto-mobile@latest")
        return 0
    fi

    return 1
}

ensure_auto_mobile_command() {
    if resolve_auto_mobile_command; then
        return 0
    fi

    log_error "AutoMobile CLI not available. Install bun (https://bun.sh) and ensure bunx is on PATH."
    return 1
}

run_auto_mobile_cli() {
    if ! ensure_auto_mobile_command; then
        return 1
    fi

    ${AUTO_MOBILE_CMD[@]+"${AUTO_MOBILE_CMD[@]}"} --cli "$@"
}

extract_device_ids() {
    local raw="$1"

    if command_exists python3; then
        python3 -c 'import json,sys
raw=sys.stdin.read()
try:
    data=json.loads(raw)
except json.JSONDecodeError:
    sys.exit(1)
def unwrap(payload):
    if isinstance(payload, dict):
        content=payload.get("content")
        if isinstance(content, list) and content:
            item=content[0]
            if isinstance(item, dict) and item.get("type")=="text":
                text=item.get("text","")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return {}
    return payload
data=unwrap(data)
devices=data.get("devices", []) if isinstance(data, dict) else []
for device in devices:
    if isinstance(device, dict):
        device_id=device.get("deviceId")
        if device_id:
            print(device_id)' <<<"${raw}"
        return $?
    fi

    if command_exists jq; then
        echo "${raw}" | jq -r '.content[0].text | fromjson | .devices[]? | .deviceId' 2>/dev/null
        return 0
    fi

    return 1
}

extract_device_images() {
    local raw="$1"

    if command_exists python3; then
        python3 -c 'import json,sys
raw=sys.stdin.read()
try:
    data=json.loads(raw)
except json.JSONDecodeError:
    sys.exit(1)
def unwrap(payload):
    if isinstance(payload, dict):
        content=payload.get("content")
        if isinstance(content, list) and content:
            item=content[0]
            if isinstance(item, dict) and item.get("type")=="text":
                text=item.get("text","")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return {}
    return payload
data=unwrap(data)
images=data.get("images", []) if isinstance(data, dict) else []
for image in images:
    if isinstance(image, dict):
        name=image.get("name") or image.get("deviceId")
        if name:
            print(name)
    elif isinstance(image, str):
        print(image)' <<<"${raw}"
        return $?
    fi

    if command_exists jq; then
        echo "${raw}" | jq -r '.content[0].text | fromjson | .images[]? | if type == "object" then (.name // .deviceId // empty) else . end' 2>/dev/null
        return 0
    fi

    return 1
}

ensure_mcp_daemon() {
    if [[ "${DAEMON_STARTED}" == "true" ]]; then
        return 0
    fi

    if ! start_mcp_daemon; then
        return 1
    fi

    DAEMON_STARTED=true
}

migrate_npm_global_auto_mobile() {
    # Detect and remove stale npm global install of auto-mobile.
    # Old versions were installed via "npm install -g @kaeawc/auto-mobile".
    # This must be cleaned up so the npm binary doesn't shadow the bun one.
    if ! command_exists npm; then
        return 0
    fi

    local npm_list_output
    npm_list_output=$(npm list -g @kaeawc/auto-mobile 2>/dev/null) || return 0

    if ! echo "${npm_list_output}" | grep -q "@kaeawc/auto-mobile"; then
        return 0
    fi

    log_warn "Found old npm global install of @kaeawc/auto-mobile"
    log_info "AutoMobile now runs exclusively on Bun. Removing npm global package..."

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Remove npm global: npm uninstall -g @kaeawc/auto-mobile")
        log_info "[DRY-RUN] Would remove npm global install"
        return 0
    fi

    npm uninstall -g @kaeawc/auto-mobile 2>/dev/null || true
    hash -r 2>/dev/null || true
    log_info "Removed npm global install of @kaeawc/auto-mobile"
    CHANGES_MADE=true
}

install_auto_mobile_cli() {
    # Clean up any stale npm global install before proceeding
    migrate_npm_global_auto_mobile

    if command_exists auto-mobile; then
        log_info "AutoMobile CLI already installed."
        return 0
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        if command_exists bun; then
            DRY_RUN_LOG+=("[DRY-RUN] Install AutoMobile CLI with Bun")
            log_info "[DRY-RUN] Would install AutoMobile CLI with: bun add -g @kaeawc/auto-mobile@latest"
        else
            log_error "Bun is required to install AutoMobile CLI. Install from https://bun.sh"
            return 1
        fi
        return 0
    fi

    if command_exists bun; then
        local install_output
        local install_status=0
        install_output=$(bun add -g @kaeawc/auto-mobile@latest 2>&1) || install_status=$?

        if [[ ${install_status} -eq 0 ]]; then
            log_info "AutoMobile CLI installed with Bun"
            CHANGES_MADE=true
            return 0
        fi

        # Try alternative bun install command
        install_output=$(bun install -g @kaeawc/auto-mobile@latest 2>&1) || install_status=$?

        if [[ ${install_status} -eq 0 ]]; then
            log_info "AutoMobile CLI installed with Bun"
            CHANGES_MADE=true
            return 0
        fi

        log_error "AutoMobile CLI installation failed with Bun:"
        echo "${install_output}"
        return 1
    fi

    log_error "Bun is required to install AutoMobile CLI. Install from https://bun.sh"
    return 1
}

install_claude_marketplace() {
    if [[ "${CLAUDE_MARKETPLACE_INSTALLED}" == "true" ]]; then
        return 0
    fi

    if [[ "${CLAUDE_CLI_INSTALLED}" != "true" ]]; then
        log_error "Claude CLI is required to install marketplace plugin"
        return 1
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Install Claude Marketplace plugin")
        log_info "[DRY-RUN] Would run: claude plugin marketplace add https://github.com/kaeawc/auto-mobile"
        return 0
    fi

    log_info "Installing Claude Marketplace plugin..."
    local install_output
    local install_status=0
    install_output=$(claude plugin marketplace add https://github.com/kaeawc/auto-mobile 2>&1) || install_status=$?

    if [[ ${install_status} -ne 0 ]]; then
        log_error "Failed to install Claude Marketplace plugin:"
        echo "${install_output}"
        return 1
    fi

    log_info "Claude Marketplace plugin installed successfully"
    CLAUDE_MARKETPLACE_INSTALLED=true
    CHANGES_MADE=true
    return 0
}

install_ide_plugin() {
    if [[ -z "${IDE_PLUGIN_DIR}" ]]; then
        log_error "IDE plugin directory not set. Skipping IDE plugin install."
        return 1
    fi

    if [[ ! -d "${IDE_PLUGIN_DIR}" ]]; then
        log_warn "IDE plugins directory not found: ${IDE_PLUGIN_DIR}. Creating it."
        mkdir -p "${IDE_PLUGIN_DIR}"
    fi

    if ! command_exists unzip; then
        log_error "unzip is required to install the IDE plugin."
        return 1
    fi

    local plugin_zip=""
    local temp_dir=""
    local build_log_path=""

    if [[ "${IDE_PLUGIN_METHOD}" == "source" ]]; then
        if [[ "${IS_REPO}" != "true" ]]; then
            log_error "Plugin build from source requires a local repository checkout."
            return 1
        fi

        build_log_path=$(mktemp)
        if ! run_with_progress "Building IDE plugin" \
            bash -c "cd \"${PROJECT_ROOT}/android/ide-plugin\" && ./gradlew buildPlugin >\"${build_log_path}\" 2>&1"; then
            log_error "IDE plugin build failed. Logs: ${build_log_path}"
            return 1
        fi

        plugin_zip=$(find "${PROJECT_ROOT}/android/ide-plugin/build/distributions" -maxdepth 1 -name '*.zip' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1 || true)
        if [[ -z "${plugin_zip}" ]]; then
            log_error "No IDE plugin zip found after build."
            return 1
        fi
    else
        if [[ -z "${IDE_PLUGIN_ZIP_URL}" ]]; then
            log_error "IDE plugin download URL not provided."
            return 1
        fi

        temp_dir=$(mktemp -d)
        plugin_zip="${temp_dir}/auto-mobile-ide-plugin.zip"

        if command_exists curl; then
            if ! run_download_with_progress "Downloading IDE plugin" \
                curl -fsSL "${IDE_PLUGIN_ZIP_URL}" -o "${plugin_zip}"; then
                log_error "Failed to download IDE plugin."
                rm -rf "${temp_dir}"
                return 1
            fi
        elif command_exists wget; then
            if ! run_download_with_progress "Downloading IDE plugin" \
                wget -qO "${plugin_zip}" "${IDE_PLUGIN_ZIP_URL}"; then
                log_error "Failed to download IDE plugin."
                rm -rf "${temp_dir}"
                return 1
            fi
        else
            log_error "curl or wget is required to download the IDE plugin."
            rm -rf "${temp_dir}"
            return 1
        fi
    fi

    local plugin_name="auto-mobile-ide-plugin"
    rm -rf "${IDE_PLUGIN_DIR:?}/${plugin_name:?}"
    if ! run_spinner "Installing IDE plugin" unzip -q "${plugin_zip}" -d "${IDE_PLUGIN_DIR}"; then
        log_error "Failed to unzip IDE plugin."
        return 1
    fi

    if [[ -n "${temp_dir}" ]]; then
        rm -rf "${temp_dir}"
    fi
    if [[ -n "${build_log_path}" ]]; then
        rm -f "${build_log_path}"
    fi

    log_info "Installed IDE plugin to ${IDE_PLUGIN_DIR}/${plugin_name}"
    log_info "Restart your IDE to load the AutoMobile plugin."
}

migrate_stale_daemon() {
    # If a daemon is already running, check if it's from an older version.
    # If so, restart it so the user gets the latest behavior automatically.
    # Note: this only checks the default socket path. Daemons started with
    # AUTOMOBILE_DAEMON_SOCKET_PATH overrides (benchmarks, XCTest) manage
    # their own lifecycle and are not affected by the installer.
    if ! is_daemon_running; then
        return 0
    fi

    local running_version
    running_version=$(get_running_daemon_version)

    if [[ -z "${running_version}" ]]; then
        # Can't determine version — offer restart to be safe
        log_warn "Running daemon has no version info (likely pre-migration)."
    else
        local target_version
        target_version=$(get_package_version)

        if [[ -n "${target_version}" ]] && [[ "${running_version}" == "${target_version}" ]]; then
            log_info "Running daemon is up to date (v${running_version})."
            return 0
        fi

        if [[ -n "${target_version}" ]]; then
            log_info "Running daemon is v${running_version}, latest is v${target_version}. Restarting..."
        else
            # Outside a repo checkout (e.g. curl pipe install) — can't determine
            # target version from package.json. Restart to ensure latest from registry.
            log_info "Running daemon is v${running_version}. Restarting to ensure latest version..."
        fi
    fi

    log_info "Restarting daemon to pick up the new version..."

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Restart daemon for version upgrade")
        log_info "[DRY-RUN] Would restart daemon"
        return 0
    fi

    if ! resolve_auto_mobile_command; then
        log_warn "Cannot restart daemon: bunx not available. Restart manually after install."
        return 0
    fi

    local restart_output
    local restart_status=0
    restart_output=$(${AUTO_MOBILE_CMD[@]+"${AUTO_MOBILE_CMD[@]}"} --daemon restart 2>&1) || restart_status=$?

    if [[ ${restart_status} -ne 0 ]]; then
        log_warn "Daemon restart failed. You may need to restart manually:"
        log_warn "  bunx @kaeawc/auto-mobile@latest --daemon restart"
        echo "${restart_output}"
        return 0
    fi

    log_info "Daemon restarted successfully."
    DAEMON_ALREADY_RUNNING=true
    CHANGES_MADE=true
}

start_mcp_daemon() {
    if ! resolve_auto_mobile_command; then
        log_error "AutoMobile CLI not available. Install bun (https://bun.sh) and ensure bunx is on PATH."
        return 1
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        DRY_RUN_LOG+=("[DRY-RUN] Start MCP daemon")
        DRY_RUN_LOG+=("[DRY-RUN] Check daemon health")
        log_info "[DRY-RUN] Would start MCP daemon"
        log_info "[DRY-RUN] Would check daemon health"
        return 0
    fi

    local daemon_output
    local daemon_status=0
    daemon_output=$(${AUTO_MOBILE_CMD[@]+"${AUTO_MOBILE_CMD[@]}"} --daemon start 2>&1) || daemon_status=$?

    if [[ ${daemon_status} -ne 0 ]]; then
        # Check for corrupted migrations error
        if echo "${daemon_output}" | grep -q "corrupted migrations"; then
            # Extract just the migration error message (from the "error:" line, not source code)
            local migration_error
            migration_error=$(echo "${daemon_output}" | grep "^error: corrupted migrations:" | sed 's/^error: //' | head -1)
            if [[ -z "${migration_error}" ]]; then
                # Fallback if format is different
                migration_error="corrupted migrations (version mismatch)"
            fi
            log_warn "Database has ${migration_error}"
            echo ""

            local should_reset=false
            if [[ "${NON_INTERACTIVE}" == "true" ]]; then
                # Default to reset in non-interactive mode
                should_reset=true
                log_info "Resetting database automatically..."
            else
                if gum confirm "Reset the AutoMobile database to fix this?" --default=true; then
                    should_reset=true
                fi
            fi

            if [[ "${should_reset}" == "true" ]]; then
                local db_dir="${HOME}/.auto-mobile"
                if [[ "${DRY_RUN}" == "true" ]]; then
                    DRY_RUN_LOG+=("[DRY-RUN] Remove database files in ${db_dir}")
                    log_info "[DRY-RUN] Would remove database files: ${db_dir}/*.db*"
                    log_info "[DRY-RUN] Would retry daemon start"
                else
                    # Remove all database files (main db, WAL, SHM)
                    rm -f "${db_dir}"/*.db* 2>/dev/null || true
                    log_info "Database files removed from ${db_dir}"

                    # Retry daemon start (reset status first)
                    daemon_status=0
                    daemon_output=$(${AUTO_MOBILE_CMD[@]+"${AUTO_MOBILE_CMD[@]}"} --daemon start 2>&1) || daemon_status=$?
                    if [[ ${daemon_status} -ne 0 ]]; then
                        log_error "Failed to start MCP daemon after database reset:"
                        echo "${daemon_output}"
                        return 1
                    fi
                    log_info "MCP daemon started after database reset"
                fi
            else
                log_error "Cannot start daemon with corrupted database. Exiting."
                return 1
            fi
        else
            log_error "Failed to start MCP daemon:"
            echo "${daemon_output}"
            return 1
        fi
    fi

    local health_output
    local health_status=0
    health_output=$(${AUTO_MOBILE_CMD[@]+"${AUTO_MOBILE_CMD[@]}"} --daemon health 2>&1) || health_status=$?

    if [[ ${health_status} -ne 0 ]]; then
        log_error "Daemon health check failed:"
        echo "${health_output}"
        return 1
    fi

    log_info "MCP daemon is running and healthy."
}

# Install runtime dependencies needed for AutoMobile features.
# These are not development/CI tools — they are required for end-user functionality:
#   ffmpeg  - video recording and encoding (videoRecording tool)
# Install a system package using the host's native package manager.
# Usage: _install_system_package <package_name> <description> [apt_name]
# apt_name defaults to package_name if not provided.
_install_system_package() {
    local pkg="$1"
    local description="$2"
    local apt_pkg="${3:-$1}"
    local os
    os=$(detect_os)

    local install_cmd=""
    local skip_hint=""

    case "${os}" in
        macos)
            if command_exists brew; then
                install_cmd="brew install ${pkg}"
                skip_hint="brew install ${pkg}"
            fi
            ;;
        linux)
            if command_exists apt-get; then
                install_cmd="sudo apt-get update -qq && sudo apt-get install -y -qq ${apt_pkg}"
                skip_hint="sudo apt-get install ${apt_pkg}"
            elif command_exists dnf; then
                install_cmd="sudo dnf install -y ${apt_pkg}"
                skip_hint="sudo dnf install ${apt_pkg}"
            elif command_exists pacman; then
                install_cmd="sudo pacman -S --noconfirm ${apt_pkg}"
                skip_hint="sudo pacman -S ${apt_pkg}"
            fi
            ;;
    esac

    if [[ -z "${install_cmd}" ]]; then
        log_warn "${pkg} not found — ${description} will be unavailable"
        return 1
    fi

    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        if ! gum confirm "Install ${pkg}? (${description})"; then
            log_info "Skipped ${pkg} — install later with: ${skip_hint}"
            # A user-declined interactive install is a successful no-op.
            return 0
        fi
    fi

    log_info "Installing ${pkg} (${description})..."
    if run_bounded_install "Installing ${pkg}" bash -c "${install_cmd}"; then
        CHANGES_MADE=true
        return 0
    fi

    log_warn "${pkg} install failed — ${description} will be unavailable"
    return 1
}

install_runtime_deps() {
    # ffmpeg — required for video recording features.
    # CI can opt out via AUTOMOBILE_INSTALL_SKIP_FFMPEG=true: ffmpeg is a large,
    # slow dependency (its install has timed out the installer check) and video
    # recording is not exercised by the installer validation jobs.
    if [[ "${AUTOMOBILE_INSTALL_SKIP_FFMPEG:-false}" == "true" ]]; then
        log_info "Skipping ffmpeg install (AUTOMOBILE_INSTALL_SKIP_FFMPEG=true) — video recording will be unavailable"
    elif ! command_exists ffmpeg; then
        _install_system_package "ffmpeg" "required for video recording"
    fi
}

# Install development tools needed by scripts/ (shellcheck, jq, ripgrep, etc.)
# These are Homebrew packages used by validation, linting, and CI scripts.
install_dev_tools() {
    local os
    os=$(detect_os)

    if [[ "${os}" == "macos" ]]; then
        _install_dev_tools_brew
    elif [[ "${os}" == "linux" ]]; then
        _install_dev_tools_apt
    else
        log_warn "Unsupported OS for dev tool installation"
    fi
}

_install_dev_tools_brew() {
    if ! command_exists brew; then
        log_warn "Homebrew not found — skipping dev tool installation"
        return 0
    fi

    # All required packages (macOS-specific ones included)
    local all_packages=(
        "shellcheck"        # shell script linting
        "jq"                # JSON processing
        "ripgrep"           # fast code search
        "yq"                # YAML processing
        "gum"               # interactive TUI prompts
        "hadolint"          # Dockerfile linting
        "xmlstarlet"        # XML processing
        "swiftformat"       # Swift formatting
        "swiftlint"         # Swift linting
        "xcodegen"          # Xcode project generation
        "libusbmuxd"        # iproxy for physical iOS device USB tunneling
        "ideviceinstaller"  # physical iOS device app management
    )

    # Single brew call to get all installed packages (~100ms vs ~300ms per package)
    local installed_packages
    installed_packages=$(brew list --formula -1 2>/dev/null || true)

    local to_install=()
    for pkg in "${all_packages[@]}"; do
        if ! echo "${installed_packages}" | grep -qx "${pkg}"; then
            to_install+=("${pkg}")
        fi
    done

    if [[ ${#to_install[@]} -eq 0 ]]; then
        log_info "Development tools ready."
        return 0
    fi

    log_info "Installing ${#to_install[@]} missing dev tool(s): ${to_install[*]}"

    if [[ "${DRY_RUN}" == "true" ]]; then
        for pkg in "${to_install[@]}"; do
            log_info "[DRY-RUN] Would install ${pkg}"
        done
        return 0
    fi

    # Homebrew serializes writes to its prefix, so separate background `brew`
    # processes would contend for the same lock. One invocation avoids repeated
    # startup work and lets Homebrew schedule the complete dependency set.
    local brew_status=0
    if run_bounded_install "Installing ${#to_install[@]} development tools" brew install ${to_install[@]+"${to_install[@]}"}; then
        :
    else
        brew_status=$?
    fi

    local installed_after
    installed_after=$(brew list --formula -1 2>/dev/null || true)
    local missing_packages=()
    for pkg in "${to_install[@]}"; do
        if ! printf '%s\n' "${installed_after}" | grep -qx "${pkg}"; then
            missing_packages+=("${pkg}")
        fi
    done

    if [[ ${#missing_packages[@]} -gt 0 ]]; then
        for pkg in "${missing_packages[@]}"; do
            log_warn "Failed to install ${pkg}"
        done
        log_warn "${#missing_packages[@]} dev tool(s) could not be installed"
        return 1
    fi

    if [[ ${brew_status} -ne 0 ]]; then
        log_warn "Homebrew reported an error after installing all requested development tools"
        return "${brew_status}"
    fi

    CHANGES_MADE=true
    log_info "Development tools ready."
}

_install_dev_tools_apt() {
    if ! command_exists apt-get; then
        log_warn "apt-get not found — skipping dev tool installation"
        return 0
    fi

    # Packages available in standard Ubuntu/Debian repos
    local apt_packages=(
        "shellcheck"    # shell script linting
        "jq"            # JSON processing
        "ripgrep"       # fast code search
        "xmlstarlet"    # XML processing
    )

    local to_install=()
    for pkg in "${apt_packages[@]}"; do
        if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
            to_install+=("${pkg}")
        fi
    done

    if [[ ${#to_install[@]} -eq 0 ]]; then
        log_info "Development tools ready."
        return 0
    fi

    log_info "Installing ${#to_install[@]} missing dev tool(s): ${to_install[*]}"

    if [[ "${DRY_RUN}" == "true" ]]; then
        for pkg in "${to_install[@]}"; do
            log_info "[DRY-RUN] Would install ${pkg}"
        done
        return 0
    fi

    # Update the package index once. A stale index is survivable — the per-package installs below report their
    # own failures — but the update must still be bounded, since it is an
    # apt-get like any other and can stall the same way.
    if run_bounded_install "Updating package index" sudo apt-get update -qq; then
        :
    fi

    local missing=0
    for pkg in ${to_install[@]+"${to_install[@]}"}; do
        if run_bounded_install "Installing ${pkg}" sudo apt-get install -y -qq "${pkg}"; then
            CHANGES_MADE=true
        else
            log_warn "Failed to install ${pkg}"
            ((missing++)) || true
        fi
    done

    if [[ ${missing} -gt 0 ]]; then
        log_warn "${missing} dev tool(s) could not be installed"
        return 1
    else
        log_info "Development tools ready."
    fi
}

handle_bun_setup() {
    # Enforce version requirement even if bun is already installed
    if [[ "${BUN_INSTALLED}" == "true" ]] && [[ -n "${REQUIRED_BUN_VERSION}" ]]; then
        local current_bun_version
        current_bun_version=$(bun --version 2>/dev/null || true)
        if [[ -n "${current_bun_version}" ]] && ! version_gte "${current_bun_version}" "${REQUIRED_BUN_VERSION}"; then
            log_warn "Bun v${current_bun_version} found but v${REQUIRED_BUN_VERSION} required"
            BUN_INSTALLED=false
        fi
    fi

    if [[ "${BUN_INSTALLED}" == "true" ]]; then
        return 0
    fi

    # If INSTALL_BUN was explicitly set (e.g., by development preset), skip Yes/No confirmation
    if [[ "${INSTALL_BUN}" == "true" ]]; then
        if install_bun "true"; then
            if command_exists bun; then
                BUN_INSTALLED=true
                CHANGES_MADE=true
            fi
        fi
        return 0
    fi

    # Otherwise, prompt the user (install_bun handles the Yes/No prompt)
    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        if install_bun; then
            if command_exists bun; then
                BUN_INSTALLED=true
                CHANGES_MADE=true
            fi
        fi
    fi

    return 0
}

# In non-interactive contributor installs, the CLI/daemon path is independent
# of Homebrew runtime and development tools once Bun is ready. Capture its
# output so concurrent work does not corrupt the installer UI, then replay it
# in order when the parent joins the task.
start_post_bun_setup() {
    if [[ "${NON_INTERACTIVE}" != "true" ]] \
        || [[ "${DRY_RUN}" == "true" ]] \
        || [[ "${INSTALL_CLAUDE_MARKETPLACE}" == "true" ]] \
        || { [[ "${INSTALL_AUTOMOBILE_CLI}" != "true" ]] && [[ "${START_DAEMON}" != "true" ]]; }; then
        return 0
    fi

    POST_BUN_SETUP_LOG_FILE=$(mktemp "${TMPDIR:-/tmp}/auto-mobile-post-bun-log.XXXXXX")
    POST_BUN_SETUP_STATE_FILE=$(mktemp "${TMPDIR:-/tmp}/auto-mobile-post-bun-state.XXXXXX")

    (
        CHANGES_MADE=false

        if [[ "${INSTALL_AUTOMOBILE_CLI}" == "true" ]]; then
            install_auto_mobile_cli
        fi

        migrate_stale_daemon

        if [[ "${START_DAEMON}" == "true" ]]; then
            start_mcp_daemon
        fi

        printf '%s\n' "${CHANGES_MADE}" >"${POST_BUN_SETUP_STATE_FILE}"
    ) >"${POST_BUN_SETUP_LOG_FILE}" 2>&1 &
    POST_BUN_SETUP_PID=$!
}

finish_post_bun_setup() {
    if [[ -z "${POST_BUN_SETUP_PID}" ]]; then
        return 0
    fi

    local setup_status=0
    if wait "${POST_BUN_SETUP_PID}"; then
        :
    else
        setup_status=$?
    fi
    POST_BUN_SETUP_PID=""

    cat "${POST_BUN_SETUP_LOG_FILE}"

    if [[ ${setup_status} -eq 0 ]] && [[ "$(cat "${POST_BUN_SETUP_STATE_FILE}")" == "true" ]]; then
        CHANGES_MADE=true
    fi

    rm -f "${POST_BUN_SETUP_LOG_FILE}" "${POST_BUN_SETUP_STATE_FILE}"
    POST_BUN_SETUP_LOG_FILE=""
    POST_BUN_SETUP_STATE_FILE=""
    return ${setup_status}
}

# Check if the public npm registry is reachable. If not (e.g. corporate
# firewall), prompt the user for a custom BUN_CONFIG_REGISTRY so that bunx
# can resolve packages through their internal registry / proxy.
check_npm_registry() {
    # Skip if already set — the env-var forwarding added elsewhere will handle it.
    if [[ -n "${BUN_CONFIG_REGISTRY:-}" ]]; then
        return 0
    fi

    # Skip in non-interactive mode — nothing we can prompt for.
    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        return 0
    fi

    # Quick probe: fetch the package metadata from the public registry.
    # A 2-second timeout keeps this fast on healthy networks.
    local registry_ok=false
    if command_exists curl; then
        if curl -sfSL --max-time 2 "https://registry.npmjs.org/@kaeawc/auto-mobile/latest" >/dev/null 2>&1; then
            registry_ok=true
        fi
    elif command_exists wget; then
        if wget -q --timeout=2 -O /dev/null "https://registry.npmjs.org/@kaeawc/auto-mobile/latest" 2>/dev/null; then
            registry_ok=true
        fi
    else
        # No way to check — optimistically continue.
        return 0
    fi

    if [[ "${registry_ok}" == "true" ]]; then
        return 0
    fi

    log_warn "Could not reach the public npm registry (registry.npmjs.org)."
    log_warn "This usually means your network requires a corporate registry or proxy."
    echo ""

    if gum confirm "Do you use a custom npm registry (e.g. Artifactory, Nexus)?"; then
        local registry_url
        registry_url=$(gum input --prompt "Registry URL: " --placeholder "https://registry.corp.example.com/npm/")
        if [[ -n "${registry_url}" ]]; then
            export BUN_CONFIG_REGISTRY="${registry_url}"
            log_info "BUN_CONFIG_REGISTRY set to ${BUN_CONFIG_REGISTRY}"
        fi
    else
        log_warn "Continuing without a custom registry — bunx may fail to install packages."
    fi
}

check_android_sdk() {
    if [[ "${ANDROID_SDK_DETECTED}" == "true" ]]; then
        return 0
    fi
    log_warn "Android SDK not detected. Install Android Studio or SDK manually for device support."
    log_warn "See https://developer.android.com/studio for installation instructions."
    return 1
}

ios_log_heading() {
    gum style --bold "iOS Setup"
    echo ""
}

ios_check_xcode() {
    if [[ "$(detect_os)" != "macos" ]]; then
        log_warn "iOS setup requires macOS."
        return 1
    fi

    if spin_check "Checking Xcode" "command -v xcodebuild >/dev/null 2>&1"; then
        local xcode_version
        xcode_version=$(xcodebuild -version 2>/dev/null | head -1 || true)
        if [[ -n "${xcode_version}" ]]; then
            log_info "Xcode detected: ${xcode_version}"
        else
            log_info "Xcode detected."
        fi
        return 0
    fi

    log_warn "Xcode not detected. Install Xcode from the App Store."
    return 1
}

ios_install_command_line_tools() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 1
    fi

    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        log_warn "Command Line Tools missing. Run: xcode-select --install"
        return 1
    fi

    if gum confirm "Command Line Tools missing. Install now?"; then
        if execute "Install Command Line Tools" xcode-select --install; then
            log_info "Command Line Tools installer started."
            log_info "Complete the installer prompt, then re-run this setup."
            return 0
        fi
        log_warn "Command Line Tools install failed. Run: xcode-select --install"
        return 1
    fi

    log_warn "Skipping Command Line Tools install. Run: xcode-select --install"
    return 1
}

ios_check_command_line_tools() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 1
    fi

    if spin_check "Checking Command Line Tools" "xcode-select -p >/dev/null 2>&1"; then
        local developer_dir
        developer_dir=$(xcode-select -p 2>/dev/null || true)
        if [[ -n "${developer_dir}" ]]; then
            log_info "Command Line Tools path: ${developer_dir}"
        fi
        return 0
    fi

    return 1
}

# Listing simulator runtimes can wake CoreSimulator and take close to a minute
# on a fresh macOS host. It is informational at this point, so start it while
# the installer continues with independent setup work.
start_ios_runtime_probe() {
    local os
    os=$(detect_os)
    if [[ "${os}" != "macos" ]]; then
        return 0
    fi
    if ! command -v xcrun >/dev/null 2>&1; then
        return 0
    fi

    IOS_RUNTIME_PROBE_FILE=$(mktemp "${TMPDIR:-/tmp}/auto-mobile-ios-runtimes.XXXXXX")
    if command_exists perl; then
        # A dedicated process group lets the timeout signal every helper in one
        # operation while this shell still waits for and reaps the direct child.
        perl -MPOSIX=setsid -e 'setsid() or die "setsid: $!\n"; exec @ARGV or die "exec: $!\n"' \
            xcrun simctl list runtimes >"${IOS_RUNTIME_PROBE_FILE}" 2>/dev/null &
        IOS_RUNTIME_PROBE_PROCESS_GROUP=true
    else
        xcrun simctl list runtimes >"${IOS_RUNTIME_PROBE_FILE}" 2>/dev/null &
        IOS_RUNTIME_PROBE_PROCESS_GROUP=false
    fi
    IOS_RUNTIME_PROBE_PID=$!
}

# Seconds to wait for the background runtime probe before abandoning it.
# Overridable so the tests can exercise the timeout path without a real stall.
IOS_RUNTIME_PROBE_TIMEOUT_SECONDS="${IOS_RUNTIME_PROBE_TIMEOUT_SECONDS:-20}"

finish_ios_runtime_probe() {
    if [[ -z "${IOS_RUNTIME_PROBE_PID}" ]]; then
        return 0
    fi

    # `xcrun simctl list` can stall indefinitely on a loaded macOS runner -- the
    # hazard #3943 documents and the reason FakeDeviceSessionManager exists. This
    # probe only decorates output with the installed runtimes, so an unbounded
    # `wait` traded a cosmetic detail for a hang: on CI it pinned a BATS job for
    # 6 hours until the runner cancelled it. Bound the join and degrade to
    # "runtimes unknown" instead.
    local probe_status=0 waited=0
    while kill -0 "${IOS_RUNTIME_PROBE_PID}" 2>/dev/null; do
        if ((waited >= IOS_RUNTIME_PROBE_TIMEOUT_SECONDS)); then
            local signal_target="${IOS_RUNTIME_PROBE_PID}"
            if [[ "${IOS_RUNTIME_PROBE_PROCESS_GROUP}" == "true" ]]; then
                signal_target="-${IOS_RUNTIME_PROBE_PID}"
            fi

            kill -TERM -- "${signal_target}" 2>/dev/null || true
            local shutdown_waited=0
            # The wrapper can exit before a helper that ignored SIGTERM. Poll
            # the isolated group so the SIGKILL fallback still reaches it.
            while kill -0 -- "${signal_target}" 2>/dev/null; do
                if ((shutdown_waited >= 10)); then
                    kill -KILL -- "${signal_target}" 2>/dev/null || true
                    break
                fi
                sleep 0.1
                shutdown_waited=$((shutdown_waited + 1))
            done
            wait "${IOS_RUNTIME_PROBE_PID}" 2>/dev/null || true
            IOS_RUNTIME_PROBE_PID=""
            IOS_RUNTIME_PROBE_PROCESS_GROUP=false
            rm -f "${IOS_RUNTIME_PROBE_FILE}"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if wait "${IOS_RUNTIME_PROBE_PID}"; then
        :
    else
        probe_status=$?
    fi
    IOS_RUNTIME_PROBE_PID=""
    IOS_RUNTIME_PROBE_PROCESS_GROUP=false

    if [[ ${probe_status} -eq 0 ]]; then
        local runtimes
        runtimes=$(grep -o 'iOS [0-9.]*' "${IOS_RUNTIME_PROBE_FILE}" | tr '\n' ',' | sed 's/,$//' || true)
        if [[ -n "${runtimes}" ]]; then
            log_info "iOS runtimes available: ${runtimes}"
        fi
    fi

    rm -f "${IOS_RUNTIME_PROBE_FILE}"
    IOS_RUNTIME_PROBE_FILE=""
    return 0
}

ios_get_installed_runtimes() {
    local runtime_output=""
    local runtimes=""

    if runtime_output=$(xcrun simctl list runtimes -j 2>/dev/null); then
        if command_exists python3; then
            runtimes=$(python3 -c '
import json, sys
data=json.loads(sys.stdin.read())
runtimes=[]
for runtime in data.get("runtimes", []):
    name=runtime.get("name", "")
    if name.startswith("iOS") and runtime.get("isAvailable", True):
        runtimes.append(name)
print("\n".join(runtimes))
' <<<"${runtime_output}")
        else
            runtime_output=""
        fi
    fi

    if [[ -z "${runtime_output}" ]] && runtime_output=$(xcrun simctl list runtimes 2>/dev/null); then
        runtimes=$(printf '%s\n' "${runtime_output}" | grep -E "^iOS" | sed 's/ - .*//' | sed 's/[[:space:]]*$//')
    fi

    if [[ -z "${runtimes}" ]]; then
        return 1
    fi

    IOS_RUNTIME_NAMES=()
    while IFS= read -r runtime; do
        if [[ -n "${runtime}" ]]; then
            IOS_RUNTIME_NAMES+=("${runtime}")
        fi
    done <<< "${runtimes}"

    return 0
}

ios_show_available_runtimes() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 1
    fi

    if command_exists xcodebuild; then
        if xcodebuild -downloadPlatform iOS -list 2>/dev/null; then
            return 0
        fi
    fi

    log_warn "Unable to list downloadable runtimes from xcodebuild."
    log_info "Open Xcode > Settings > Platforms to view available runtimes."
    return 1
}

ios_download_runtime() {
    local runtime_version="${1:-}"
    if [[ -n "${runtime_version}" ]]; then
        execute_spinner "Downloading iOS runtime ${runtime_version}" \
            xcodebuild -downloadPlatform iOS -buildVersion "${runtime_version}"
    else
        execute_spinner "Downloading latest iOS runtime" \
            xcodebuild -downloadPlatform iOS
    fi
}

ios_prompt_download_runtimes() {
    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        log_warn "No iOS runtimes installed. Run: xcodebuild -downloadPlatform iOS"
        log_info "Or install via Xcode > Settings > Platforms."
        return 1
    fi

    gum style --faint "Missing iOS simulator runtimes."
    echo ""

    local choice
    choice=$(gum choose \
        "Yes, install latest iOS runtime" \
        "Choose runtime version" \
        "Show available runtimes" \
        "No, skip")

    case "${choice}" in
        "Yes, install latest iOS runtime")
            ios_download_runtime
            ;;
        "Choose runtime version")
            if ios_show_available_runtimes; then
                local version
                version=$(gum input --prompt "Runtime build version (e.g. 21E213): " --value "")
                if [[ -n "${version}" ]]; then
                    ios_download_runtime "${version}"
                else
                    log_warn "No version provided. Skipping runtime install."
                fi
            else
                local version
                version=$(gum input --prompt "Runtime build version (optional): " --value "")
                if [[ -n "${version}" ]]; then
                    ios_download_runtime "${version}"
                else
                    ios_download_runtime
                fi
            fi
            ;;
        "Show available runtimes")
            ios_show_available_runtimes
            ios_prompt_download_runtimes
            ;;
        *)
            log_warn "Skipping runtime installation."
            ;;
    esac
}

ios_check_simulator_runtimes() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 1
    fi

    if ! command_exists xcrun; then
        log_warn "xcrun not available. Install Xcode Command Line Tools."
        return 1
    fi

    if ! ios_get_installed_runtimes; then
        log_warn "No iOS simulator runtimes available."
        ios_prompt_download_runtimes
        return 1
    fi

    local runtime_list
    runtime_list=$(IFS=", "; printf '%s' "${IOS_RUNTIME_NAMES[*]}")
    log_info "iOS runtimes available: ${runtime_list}"
    return 0
}

ios_check_ctrl_proxy_build() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 1
    fi

    if [[ "${IS_REPO}" != "true" ]]; then
        log_info "CtrlProxy iOS build handled by AutoMobile on first use."
        return 0
    fi

    local xctest_dir="${PROJECT_ROOT}/ios/control-proxy"
    if [[ ! -d "${xctest_dir}" ]]; then
        log_warn "CtrlProxy iOS project not found in repo."
        log_info "AutoMobile will install/build CtrlProxy iOS when needed."
        return 1
    fi

    if run_spinner "Validating CtrlProxy iOS project" bash -c "cd \"${xctest_dir}\" && xcodebuild -list -json >/dev/null 2>&1"; then
        log_info "CtrlProxy iOS project detected. AutoMobile will build on demand."
        return 0
    fi

    log_warn "Unable to query CtrlProxy iOS project. AutoMobile will build on demand."
    return 1
}

run_ios_setup() {
    if [[ "$(detect_os)" != "macos" ]]; then
        log_warn "iOS setup skipped (macOS required)."
        return 0
    fi

    ios_log_heading

    if ! ios_check_xcode; then
        log_warn "Skipping iOS setup because Xcode is missing."
        return 0
    fi

    if ! ios_check_command_line_tools; then
        ios_install_command_line_tools
    fi

    ios_check_simulator_runtimes
    ios_check_ctrl_proxy_build
    ios_check_physical_device_tools
    return 0
}

# Check and offer to install libimobiledevice tools for physical iOS device support.
# Requires: libusbmuxd (iproxy), libimobiledevice (idevice_id), ideviceinstaller
ios_check_physical_device_tools() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 0
    fi

    local missing_tools=()
    command_exists iproxy          || missing_tools+=("iproxy (libusbmuxd)")
    command_exists idevice_id      || missing_tools+=("idevice_id (libimobiledevice)")
    command_exists ideviceinstaller || missing_tools+=("ideviceinstaller")

    if [[ ${#missing_tools[@]} -eq 0 ]]; then
        log_info "Physical iOS device tools: all present"
        return 0
    fi

    log_warn "Missing physical iOS device tools: ${missing_tools[*]}"

    if ! command_exists brew; then
        log_info "Install with: brew install libusbmuxd ideviceinstaller"
        return 0
    fi

    if [[ "${NON_INTERACTIVE}" == "true" ]]; then
        log_info "Installing libimobiledevice tools (required for physical iOS devices)..."
        _install_libimobiledevice_tools
    elif gum confirm "Install libimobiledevice tools? (required for physical iOS devices)"; then
        _install_libimobiledevice_tools
    else
        log_info "Skipped — install later with: brew install libusbmuxd ideviceinstaller"
    fi
}

_install_libimobiledevice_tools() {
    # ideviceinstaller depends on libimobiledevice; libusbmuxd provides iproxy
    if run_bounded_install "Installing libusbmuxd" brew install libusbmuxd; then
        CHANGES_MADE=true
    else
        log_warn "libusbmuxd install failed — iproxy will be unavailable"
    fi
    if run_bounded_install "Installing ideviceinstaller" brew install ideviceinstaller; then
        CHANGES_MADE=true
    else
        log_warn "ideviceinstaller install failed — physical device app install will be unavailable"
    fi
}

# Report or install physical device tools depending on preset.
# In development/local-dev presets, offers to install. Otherwise just reports.
ios_report_physical_device_tools() {
    if [[ "$(detect_os)" != "macos" ]]; then
        return 0
    fi

    local missing_tools=()
    command_exists iproxy          || missing_tools+=("iproxy")
    command_exists idevice_id      || missing_tools+=("idevice_id")
    command_exists ideviceinstaller || missing_tools+=("ideviceinstaller")

    if [[ ${#missing_tools[@]} -eq 0 ]]; then
        log_info "Physical iOS device tools: all present"
        return 0
    fi

    # In development preset, offer to install
    if [[ "${INSTALL_DEV_TOOLS}" == "true" ]] && command_exists brew; then
        ios_check_physical_device_tools
    else
        log_info "Physical iOS device tools not installed: ${missing_tools[*]} (needed for USB-connected iPhones only)"
        log_info "Install with: brew install libusbmuxd ideviceinstaller"
    fi
}

collect_choices() {
    if [[ "${BUN_INSTALLED}" == "false" ]]; then
        if gum confirm "Bun is required for AutoMobile. Install Bun now?"; then
            INSTALL_BUN=true
        fi
    fi

    # Check if IDE plugin is available in latest release
    if [[ "${platform_choice}" == "Android" || "${platform_choice}" == "Both" ]]; then
        local ide_plugin_url
        ide_plugin_url=$(resolve_ide_plugin_url || true)
        if [[ -n "${ide_plugin_url}" ]]; then
            if gum confirm "Install AutoMobile IntelliJ/Android Studio plugin?"; then
                INSTALL_IDE_PLUGIN=true
                IDE_PLUGIN_METHOD="release"
                IDE_PLUGIN_ZIP_URL="${ide_plugin_url}"

                IDE_PLUGIN_DIR=$(detect_ide_plugins_dir || true)
                if [[ -z "${IDE_PLUGIN_DIR}" ]]; then
                    IDE_PLUGIN_DIR=$(gum input --prompt "IDE plugins directory: " --value "")
                fi
            fi
        fi
    fi

    # Only ask about CLI install if not already installed
    if [[ "${CLI_ALREADY_INSTALLED}" != "true" ]]; then
        if gum confirm "Install AutoMobile CLI (auto-mobile command) globally?"; then
            INSTALL_AUTOMOBILE_CLI=true
        fi
    fi

    # Only ask about daemon if not already running
    if [[ "${DAEMON_ALREADY_RUNNING}" != "true" ]]; then
        if gum confirm "Start MCP daemon and verify health?"; then
            START_DAEMON=true
        fi
    fi
}

resolve_android_sdk_root() {
    if [[ -n "${ANDROID_HOME:-}" ]]; then
        echo "${ANDROID_HOME}"
        return 0
    fi
    if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
        echo "${ANDROID_SDK_ROOT}"
        return 0
    fi
    if [[ -n "${ANDROID_SDK_HOME:-}" ]]; then
        echo "${ANDROID_SDK_HOME}"
        return 0
    fi

    if [[ "$(detect_os)" == "macos" ]]; then
        echo "${HOME}/Library/Android/sdk"
    else
        echo "${HOME}/Android/Sdk"
    fi
}

install_bun_curl() {
    local temp_dir
    temp_dir=$(mktemp -d)
    local installer_path="${temp_dir}/bun-install.sh"
    local log_path="${temp_dir}/bun-install.log"

    if command_exists curl; then
        if ! run_spinner "Downloading Bun installer" \
            curl -fsSL "https://bun.sh/install" -o "${installer_path}"; then
            log_error "Failed to download Bun installer."
            rm -rf "${temp_dir}"
            return 1
        fi
    elif command_exists wget; then
        if ! run_spinner "Downloading Bun installer" \
            wget -qO "${installer_path}" "https://bun.sh/install"; then
            log_error "Failed to download Bun installer."
            rm -rf "${temp_dir}"
            return 1
        fi
    else
        log_error "curl or wget is required to download Bun."
        rm -rf "${temp_dir}"
        return 1
    fi

    chmod +x "${installer_path}"

    if ! run_with_progress "Installing Bun" bash -c "bash \"${installer_path}\" >\"${log_path}\" 2>&1"; then
        log_error "Bun installation failed. Logs: ${log_path}"
        return 1
    fi

    export PATH="${HOME}/.bun/bin:${PATH}"
    rm -rf "${temp_dir}"
    return 0
}

install_bun_homebrew() {
    # Add the oven-sh/bun tap if not already added
    if ! brew tap 2>/dev/null | grep -q "oven-sh/bun"; then
        if ! run_bounded_install "Adding Homebrew tap oven-sh/bun" brew tap oven-sh/bun; then
            log_error "Failed to add Homebrew tap."
            return 1
        fi
    fi

    if ! run_bounded_install "Installing Bun via Homebrew" brew install oven-sh/bun/bun; then
        log_error "Bun installation via Homebrew failed."
        return 1
    fi

    return 0
}


install_bun() {
    local skip_confirm="${1:-false}"  # If true, skip the Yes/No prompt (already confirmed)
    local os
    os=$(detect_os)
    local install_method="curl"

    # Build list of available installation methods
    local options=()
    options+=("Official installer (curl | bash)")
    if [[ "${os}" == "macos" ]] && command_exists brew; then
        options+=("Homebrew (brew install)")
    fi

    # Ask user which method to use
    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        if [[ ${#options[@]} -gt 1 ]]; then
            # Multiple options - show choose menu with Skip option
            options+=("Skip")
            local choice
            choice=$(printf '%s\n' ${options[@]+"${options[@]}"} | gum choose --header "How would you like to install Bun?")

            if [[ -z "${choice}" || "${choice}" == "Skip" ]]; then
                log_info "Skipped Bun installation"
                return 1
            fi

            case "${choice}" in
                "Homebrew"*)
                    install_method="homebrew"
                    ;;
                *)
                    install_method="curl"
                    ;;
            esac
        else
            # Only one option - ask Yes/No confirmation unless already confirmed
            if [[ "${skip_confirm}" != "true" ]]; then
                if ! gum confirm "Install Bun via official installer (curl | bash)?"; then
                    log_info "Skipped Bun installation"
                    return 1
                fi
            fi
        fi
    fi

    local install_status=0
    case "${install_method}" in
        homebrew)
            install_bun_homebrew || install_status=$?
            ;;
        *)
            install_bun_curl || install_status=$?
            ;;
    esac

    if [[ "${install_status}" -ne 0 ]]; then
        return 1
    fi

    if command_exists bun; then
        log_info "Bun installed: $(bun --version)"
    else
        log_warn "Bun installed but not on PATH. Restart your shell or add bun to PATH."
    fi

    return 0
}

# ============================================================================
# Preset System
# ============================================================================

# Apply a preset configuration
apply_preset() {
    local preset_name="$1"

    case "${preset_name}" in
        minimal)
            # MCP client config + ensure bun is installed (configs reference bunx)
            INSTALL_BUN=true
            INSTALL_IDE_PLUGIN=false
            INSTALL_AUTOMOBILE_CLI=false
            START_DAEMON=false
            CONFIGURE_MCP_CLIENTS=true
            ;;
        marketplace)
            # Claude Marketplace plugin (requires bun since plugin uses bunx)
            INSTALL_BUN=true
            INSTALL_IDE_PLUGIN=false
            INSTALL_AUTOMOBILE_CLI=false
            START_DAEMON=false
            CONFIGURE_MCP_CLIENTS=false
            INSTALL_CLAUDE_MARKETPLACE=true
            ;;
        development)
            INSTALL_BUN=true
            INSTALL_DEV_TOOLS=true
            # IDE plugin only installed if available in release
            local ide_url
            ide_url=$(resolve_ide_plugin_url || true)
            if [[ -n "${ide_url}" ]]; then
                INSTALL_IDE_PLUGIN=true
                IDE_PLUGIN_METHOD="release"
                IDE_PLUGIN_ZIP_URL="${ide_url}"
                IDE_PLUGIN_DIR=$(detect_ide_plugins_dir || true)
            else
                INSTALL_IDE_PLUGIN=false
            fi
            # Skip CLI install if already installed
            if [[ "${CLI_ALREADY_INSTALLED}" == "true" ]]; then
                INSTALL_AUTOMOBILE_CLI=false
            else
                INSTALL_AUTOMOBILE_CLI=true
            fi
            # Skip daemon start if already running
            if [[ "${DAEMON_ALREADY_RUNNING}" == "true" ]]; then
                START_DAEMON=false
            else
                START_DAEMON=true
            fi
            CONFIGURE_MCP_CLIENTS=true
            ;;
        local-dev)
            # Dependencies for hot-reload local development
            INSTALL_BUN=true
            RUN_NPM_INSTALL=true
            INSTALL_IDE_PLUGIN=false
            INSTALL_AUTOMOBILE_CLI=false
            START_DAEMON=false
            CONFIGURE_MCP_CLIENTS=false
            INSTALL_CLAUDE_MARKETPLACE=false
            ;;
        *)
            log_error "Unknown preset: ${preset_name}"
            return 1
            ;;
    esac
}

# Check if a client base name has auto-mobile configured
# Matches "Cursor" to "Cursor (Global)" etc.
client_base_has_config() {
    local base_name="$1"
    detect_mcp_clients
    for entry in ${MCP_CLIENT_LIST[@]+"${MCP_CLIENT_LIST[@]}"}; do
        local entry_name
        entry_name=$(echo "${entry}" | cut -d'|' -f1)
        if [[ "${entry_name}" == "${base_name}"* ]]; then
            if client_has_auto_mobile "${entry_name}"; then
                return 0
            fi
        fi
    done
    return 1
}

# Interactive preset selection
select_preset() {
    local choice
    local options=()
    local has_existing_config=false

    detect_mcp_clients
    local available_clients
    available_clients=$(get_detected_client_names)

    if [[ -z "${available_clients}" ]]; then
        if [[ "${MCP_CONFIG_SCOPE}" == "project" ]]; then
            log_error "No supported project MCP configurations are available. Install Claude Code, Codex, Cursor, or VS Code, then run this installer again."
        else
            log_error "No supported MCP client was detected. Install one, then run this installer again."
        fi
        return 1
    fi

    while IFS= read -r client; do
        if client_has_auto_mobile "${client}"; then
            has_existing_config=true
            break
        fi
    done <<< "${available_clients}"

    # Keep current setup option first (only if there are existing configs)
    if [[ "${has_existing_config}" == "true" ]]; then
        options+=("Leave existing AutoMobile configurations unchanged")
    fi

    # The Claude Marketplace is user-scoped, so it is not offered for a
    # project-only installation.
    if [[ "${MCP_CONFIG_SCOPE}" != "project" && "${CLAUDE_CLI_INSTALLED}" == "true" ]]; then
        if [[ "${CLAUDE_MARKETPLACE_INSTALLED}" == "true" ]]; then
            options+=("Claude Marketplace — already configured")
        else
            options+=("Claude Marketplace — install the AutoMobile plugin for Claude Code")
        fi
    fi

    while IFS= read -r client; do
        local config_path
        config_path=$(get_client_config_path "${client}")
        local recommendation=""
        if [[ "${client}" == "Claude Code"* || "${client}" == "Codex"* ]]; then
            recommendation=" — recommended"
        fi

        if client_has_auto_mobile "${client}"; then
            options+=("${client}${recommendation} — already configured")
        else
            options+=("${client}${recommendation} — add AutoMobile to ${config_path}")
        fi
    done <<< "${available_clients}"

    # In dry-run or record mode, take the same safe path without interaction.
    if [[ "${DRY_RUN}" == "true" || "${RECORD_MODE}" == "true" ]]; then
        if [[ "${MCP_CONFIG_SCOPE}" != "project" && "${CLAUDE_CLI_INSTALLED}" == "true" ]]; then
            choice="Claude Marketplace"
        else
            choice=$(printf '%s\n' "${available_clients}" | head -1)
        fi
    else
        choice=$(printf '%s\n' ${options[@]+"${options[@]}"} | gum filter --header "Select installation preset:" --placeholder "Type to filter...") || true
    fi

    # Handle Ctrl+C or empty selection - exit script
    if [[ -z "${choice}" ]]; then
        echo ""
        echo "Installation cancelled."
        exit 130
    fi

    case "${choice}" in
        "Leave existing AutoMobile configurations unchanged")
            log_info "Keeping current AI agent setup"
            log_info "No changes necessary"
            exit 0
            ;;
        "Claude Marketplace"*)
            PRESET="marketplace"
            apply_preset "marketplace"
            return 0
            ;;
        "Claude Code"*|"Claude Desktop"*|"Cursor"*|"Windsurf"*|"VS Code"*|"Codex"*|"Goose"*)
            # Configure specific AI agent
            PRESET="minimal"
            apply_preset "minimal"
            # Extract base client name - strip " (configured)" suffix if present
            PRESET_CLIENT_FILTER="${choice%% —*}"
            return 0
            ;;
    esac

    return 1
}

main() {
    # Parse command line arguments first (before gum is available)
    parse_args "$@"

    # Early detection of existing setup (before gum)
    detect_existing_setup

    ensure_gum

    gum style --bold "AutoMobile Interactive Installer"
    play_logo_animation

    # Show mode indicators
    if [[ "${DRY_RUN}" == "true" ]]; then
        echo ""
        gum style --foreground 214 --bold "DRY-RUN MODE: No changes will be made"
        echo ""
    elif [[ "${RECORD_MODE}" == "true" ]]; then
        echo ""
        gum style --foreground 212 --bold "RECORD MODE: Auto-selecting defaults"
        echo ""
    fi

    local os
    os=$(detect_os)
    if [[ "${os}" == "unknown" ]]; then
        log_error "This installer supports macOS and Linux only."
        exit 1
    fi

    log_info "Starting setup from ${PROJECT_ROOT}"

    # Parse required versions from package.json (when running from repo)
    parse_required_versions

    # =========================================================================
    # Detect current setup BEFORE asking any questions
    # =========================================================================
    echo ""
    gum style --bold "Current Setup"

    # Check Bun
    if spin_check "Checking Bun" "command -v bun >/dev/null 2>&1"; then
        BUN_INSTALLED=true
    else
        BUN_INSTALLED=false
    fi

    # Check runtime dependencies
    spin_check "Checking ffmpeg" "command -v ffmpeg >/dev/null 2>&1" || true

    # Check Android SDK
    local adb_check="command -v adb >/dev/null 2>&1 || [[ -x \"${ANDROID_HOME:-}/platform-tools/adb\" ]] || [[ -x \"${ANDROID_SDK_ROOT:-}/platform-tools/adb\" ]] || [[ -x \"${HOME}/Library/Android/sdk/platform-tools/adb\" ]] || [[ -x \"${HOME}/Android/Sdk/platform-tools/adb\" ]]"
    if spin_check "Checking Android SDK (adb)" "${adb_check}"; then
        ANDROID_SDK_DETECTED=true
        ANDROID_SETUP_OK=true

        # Detect ANDROID_HOME
        local detected_android_home=""
        if [[ -n "${ANDROID_HOME:-}" ]]; then
            detected_android_home="${ANDROID_HOME}"
        elif [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
            detected_android_home="${ANDROID_SDK_ROOT}"
        elif [[ -d "${HOME}/Library/Android/sdk" ]]; then
            detected_android_home="${HOME}/Library/Android/sdk"
        elif [[ -d "${HOME}/Android/Sdk" ]]; then
            detected_android_home="${HOME}/Android/Sdk"
        fi

        if [[ -n "${detected_android_home}" ]]; then
            log_info "Android SDK path: ${detected_android_home}"

            # Offer to set ANDROID_HOME in shell profile if not already set
            if [[ "${ANDROID_HOME_FROM_ENV}" != "true" ]]; then
                offer_android_home_shell_setup "${detected_android_home}"
            fi

            # Check Android emulator
            local emulator_path="${detected_android_home}/emulator/emulator"
            if [[ -x "${emulator_path}" ]]; then
                log_info "Checking Android emulator: ok"
            else
                log_warn "Checking Android emulator: missing — install via Android Studio SDK Manager or: sdkmanager 'emulator'"
            fi

            # Verify the SDK platform Gradle requires (platforms/android-<compileSdk>)
            # is installed. Without it, `adb` is present but the build fails with
            # "Unable to find android.jar for compileSdk N" (issue #2680). Derive
            # the version from libs.versions.toml so bumping compileSdk needs no
            # installer edit.
            local libs_toml="${PROJECT_ROOT}/android/gradle/libs.versions.toml"
            local compile_sdk install_advice platform_status
            compile_sdk=$(read_required_compile_sdk "${libs_toml}" 2>/dev/null || true)
            # Capture status via `if` so `set -e` doesn't abort on the non-zero
            # (missing/unknown) return codes, which are expected signals here.
            if install_advice=$(android_platform_install_advice "${detected_android_home}" "${libs_toml}"); then
                platform_status=0
            else
                platform_status=$?
            fi
            if [[ "${platform_status}" -eq 0 ]]; then
                log_info "Checking Android SDK platform (android-${compile_sdk}): ok"
            elif [[ "${platform_status}" -eq 2 ]]; then
                # Surface an actionable message BEFORE the Gradle build runs, and
                # drop the green Android status so this isn't silently skipped.
                ANDROID_SETUP_OK=false
                log_warn "Checking Android SDK platform (android-${compile_sdk}): missing — required for compileSdk ${compile_sdk}. Install with: ${install_advice}"
            fi
            # platform_status == 1: required compileSdk unknown (running outside
            # the repo / toml absent) — nothing actionable, skip the check.

            # List available AVDs with API levels
            if [[ -x "${emulator_path}" ]]; then
                local avd_list
                avd_list=$("${emulator_path}" -list-avds 2>/dev/null | head -10 || true)
                if [[ -n "${avd_list}" ]]; then
                    # Get API levels for each AVD
                    local avd_info=""
                    while IFS= read -r avd_name; do
                        if [[ -n "${avd_name}" ]]; then
                            local avd_ini="${HOME}/.android/avd/${avd_name}.avd/config.ini"
                            local api_level=""
                            if [[ -f "${avd_ini}" ]]; then
                                api_level=$(grep -o 'image.sysdir.1=.*android-[0-9]*' "${avd_ini}" 2>/dev/null | grep -o 'android-[0-9]*' | head -1 || true)
                                api_level="${api_level#android-}"
                            fi
                            if [[ -n "${api_level}" ]]; then
                                avd_info="${avd_info}${avd_name} (API ${api_level}),"
                            else
                                avd_info="${avd_info}${avd_name},"
                            fi
                        fi
                    done <<< "${avd_list}"
                    avd_info="${avd_info%,}"  # Remove trailing comma
                    if [[ -n "${avd_info}" ]]; then
                        log_info "Android AVDs available: ${avd_info}"
                    fi
                fi
            fi
        fi
    else
        ANDROID_SDK_DETECTED=false
    fi

    # Check iOS setup (macOS only)
    if [[ "${os}" == "macos" ]]; then
        # Check Xcode
        if spin_check "Checking Xcode" "command -v xcodebuild >/dev/null 2>&1"; then
            local xcode_version
            xcode_version=$(xcodebuild -version 2>/dev/null | head -1 || true)
            if [[ -n "${xcode_version}" ]]; then
                log_info "Xcode detected: ${xcode_version}"
            fi

            # Check Command Line Tools
            if spin_check "Checking Command Line Tools" "xcode-select -p >/dev/null 2>&1"; then
                local clt_path
                clt_path=$(xcode-select -p 2>/dev/null || true)
                log_info "Command Line Tools path: ${clt_path}"

                # Listing simulator runtimes may start CoreSimulator and is
                # slow on a fresh host. It has no bearing on setup readiness,
                # so collect it while the remaining installer work proceeds.
                start_ios_runtime_probe

                # Check devicectl (Xcode 15+ physical device control)
                spin_check "Checking devicectl" "xcrun devicectl --version >/dev/null 2>&1" || true

                IOS_SETUP_OK=true
            fi
        fi

        # Check libimobiledevice tools (only needed for physical iOS devices over USB)
        local ios_usb_missing=()
        command_exists iproxy          || ios_usb_missing+=("iproxy")
        command_exists idevice_id      || ios_usb_missing+=("idevice_id")
        command_exists ideviceinstaller || ios_usb_missing+=("ideviceinstaller")
        if [[ ${#ios_usb_missing[@]} -eq 0 ]]; then
            log_info "Checking physical iOS device tools: ok"
        else
            log_info "Checking physical iOS device tools: not installed (needed for USB-connected iPhones only)"
        fi
    fi

    # Check AutoMobile CLI
    if [[ "${CLI_ALREADY_INSTALLED}" == "true" ]]; then
        log_info "Checking AutoMobile CLI: installed"
    else
        log_info "Checking AutoMobile CLI: not installed"
    fi

    # Check MCP daemon
    if [[ "${DAEMON_ALREADY_RUNNING}" == "true" ]]; then
        log_info "Checking MCP daemon: running"
    else
        log_info "Checking MCP daemon: not running"
    fi

    # Check Claude CLI and marketplace
    if [[ "${CLAUDE_CLI_INSTALLED}" == "true" ]]; then
        # Check marketplace plugin (deferred from early detection because it's a slow network call)
        if spin_check "Checking Claude marketplace plugin" "claude plugin marketplace list 2>/dev/null | grep -q 'auto-mobile' 2>/dev/null"; then
            CLAUDE_MARKETPLACE_INSTALLED=true
            log_info "Claude CLI: installed (marketplace plugin installed)"
        else
            log_info "Claude CLI: installed"
        fi
    else
        log_info "Checking Claude CLI: not installed"
    fi

    echo ""

    # Decide whether this run configures a Git project or user-wide agent
    # settings before showing any agent-specific choices.
    detect_invocation_project
    set_installation_steps \
        "Choose project or global setup" \
        "Select AI agent configurations" \
        "Prepare the Bun runtime" \
        "Apply the selected AutoMobile configuration" \
        "Offer optional video-recording support" \
        "Configure optional device support" \
        "Install optional tools and complete the selected integration"
    show_installation_progress 1
    select_mcp_config_scope

    # =========================================================================
    # Handle preset mode
    # =========================================================================
    if [[ -n "${PRESET}" ]]; then
        show_installation_progress 2
        apply_preset "${PRESET}"
    elif [[ "${NON_INTERACTIVE}" == "true" ]]; then
        # Default to minimal in non-interactive mode without preset
        show_installation_progress 2
        apply_preset "minimal"
    else
        # Interactive mode - offer preset selection
        show_installation_progress 2
        if ! select_preset; then
            # A missing MCP client is a terminal condition; continuing would
            # present unrelated platform and CLI prompts after this error.
            exit 1
        fi
    fi

    if [[ "${NON_INTERACTIVE}" != "true" ]]; then
        offer_desktop_app_install
    fi

    # Only do interactive platform/component selection if using Custom preset
    local platform_choice="Skip platform setup"
    if [[ -z "${PRESET}" ]] && [[ "${NON_INTERACTIVE}" != "true" ]] && [[ "${CONFIGURE_MCP_CLIENTS}" != "true" || "${INSTALL_BUN}" != "true" ]]; then
        # Determine if we need to ask about platform setup
        local need_platform_choice=false
        local platform_options=()

        if [[ "${os}" == "macos" ]]; then
            # macOS can have both Android and iOS
            if [[ "${ANDROID_SETUP_OK}" == "true" && "${IOS_SETUP_OK}" == "true" ]]; then
                # Both platforms fully setup - skip the question
                log_info "Both Android and iOS environments detected and ready"
                platform_choice="Both"
            else
                need_platform_choice=true
                # Build options based on what's missing
                if [[ "${ANDROID_SETUP_OK}" != "true" ]]; then
                    platform_options+=("Android")
                fi
                if [[ "${IOS_SETUP_OK}" != "true" ]]; then
                    platform_options+=("iOS")
                fi
                if [[ "${ANDROID_SETUP_OK}" != "true" && "${IOS_SETUP_OK}" != "true" ]]; then
                    platform_options+=("Both")
                fi

                # Add skip option with current status
                local skip_label="Skip"
                if [[ "${ANDROID_SETUP_OK}" == "true" ]]; then
                    skip_label="Skip (Android ready)"
                elif [[ "${IOS_SETUP_OK}" == "true" ]]; then
                    skip_label="Skip (iOS ready)"
                else
                    skip_label="Skip (no platform setup)"
                fi
                platform_options+=("${skip_label}")
            fi
        else
            # Non-macOS - only Android is available
            if [[ "${ANDROID_SETUP_OK}" == "true" ]]; then
                log_info "Android environment detected and ready"
                platform_choice="Android"
            else
                need_platform_choice=true
                platform_options+=("Android")
                platform_options+=("Skip (no platform setup)")
            fi
        fi

        if [[ "${need_platform_choice}" == "true" ]]; then
            platform_choice=$(printf '%s\n' ${platform_options[@]+"${platform_options[@]}"} | gum choose --header "Platform setup:")
            # Normalize skip choices
            if [[ "${platform_choice}" == Skip* ]]; then
                platform_choice="Skip platform setup"
            fi
        fi

        collect_choices
    else
        # Set platform_choice based on IDE plugin installation (for preset mode)
        if [[ "${INSTALL_IDE_PLUGIN}" == "true" ]]; then
            platform_choice="Android"
        fi
    fi

    # Bun setup — must happen before MCP config writing since configs reference bunx
    show_installation_progress 3
    handle_bun_setup

    # Check npm registry reachability — prompt for custom registry if blocked
    check_npm_registry

    # Verify bunx is available before writing configs that depend on it.
    # If bun installation failed, don't rewrite working npx configs to bunx.
    if [[ "${CONFIGURE_MCP_CLIENTS}" == "true" ]] && ! command_exists bunx; then
        log_error "Bun is not available. Skipping MCP config updates to avoid breaking existing setup."
        log_error "Install bun (https://bun.sh) and re-run the installer."
        CONFIGURE_MCP_CLIENTS=false
    fi

    # MCP Client Configuration (new feature!)
    if [[ "${CONFIGURE_MCP_CLIENTS}" == "true" ]]; then
        show_installation_progress 4
        echo ""
        gum style --bold "MCP Client Configuration"
        echo ""

        if [[ -n "${PRESET_CLIENT_FILTER}" ]]; then
            # User selected a specific AI agent - auto-configure matching clients
            detect_mcp_clients
            local matching_clients=()
            for entry in ${MCP_CLIENT_LIST[@]+"${MCP_CLIENT_LIST[@]}"}; do
                local entry_name
                entry_name=$(echo "${entry}" | cut -d'|' -f1)
                # Match clients that start with the filter (e.g., "Cursor" matches "Cursor (Global)")
                if [[ "${entry_name}" == "${PRESET_CLIENT_FILTER}"* ]]; then
                    matching_clients+=("${entry_name}")
                fi
            done

            if [[ ${#matching_clients[@]} -gt 0 ]]; then
                SELECTED_MCP_CLIENTS=("${matching_clients[@]}")
                log_info "Configuring ${PRESET_CLIENT_FILTER}..."
                configure_selected_mcp_clients
            else
                log_warn "No ${PRESET_CLIENT_FILTER} installation detected."
                log_info "Install ${PRESET_CLIENT_FILTER} first, then run this installer again."
            fi
        elif [[ "${NON_INTERACTIVE}" == "true" ]]; then
            # In non-interactive mode, configure the preferred client for the
            # selected scope: Claude Code first, then Codex.
            detect_mcp_clients
            local claude_code_target="Claude Code (User)"
            local codex_target="Codex (User)"
            if [[ "${MCP_CONFIG_SCOPE}" == "project" ]]; then
                claude_code_target="Claude Code (Project)"
                codex_target="Codex (Project)"
            fi
            local claude_code_entry
            claude_code_entry=$(find_client_entry "${claude_code_target}" 2>/dev/null || echo "")
            if [[ -n "${claude_code_entry}" ]]; then
                SELECTED_MCP_CLIENTS=("${claude_code_target}")
                configure_selected_mcp_clients
            else
                local codex_entry
                codex_entry=$(find_client_entry "${codex_target}" 2>/dev/null || echo "")
                if [[ -n "${codex_entry}" ]]; then
                    SELECTED_MCP_CLIENTS=("${codex_target}")
                    configure_selected_mcp_clients
                else
                    log_info "No supported MCP clients auto-detected in non-interactive mode"
                fi
            fi
        else
            if select_mcp_clients; then
                configure_selected_mcp_clients
            fi
        fi
    fi

    # bun install (for local-dev preset)
    if [[ "${RUN_NPM_INSTALL}" == "true" ]] && [[ "${IS_REPO}" == "true" ]]; then
        if ! execute_spinner "Running bun install" bash -c "cd '${PROJECT_ROOT}' && bun install"; then
            log_warn "bun install failed"
        fi
    fi

    start_post_bun_setup

    # Runtime dependencies (needed for AutoMobile features)
    show_installation_progress 5
    install_runtime_deps

    # Development tools (shellcheck, jq, ripgrep, etc.)
    if [[ "${INSTALL_DEV_TOOLS}" == "true" ]]; then
        install_dev_tools
    fi

    # Platform-specific setup
    show_installation_progress 6
    case "${platform_choice}" in
        Android)
            # Only run setup if not already detected as ready
            if [[ "${ANDROID_SETUP_OK}" != "true" ]]; then
                check_android_sdk
            fi
            if [[ "${INSTALL_IDE_PLUGIN}" == "true" ]]; then
                install_ide_plugin
            fi
            ;;
        iOS)
            # Only run setup if not already detected as ready
            if [[ "${IOS_SETUP_OK}" != "true" ]]; then
                run_ios_setup
            else
                # Xcode already detected — report physical device tool status (no auto-install)
                ios_report_physical_device_tools
            fi
            ;;
        Both)
            # Only run setup for platforms not already detected as ready
            if [[ "${ANDROID_SETUP_OK}" != "true" ]]; then
                check_android_sdk
            fi
            if [[ "${INSTALL_IDE_PLUGIN}" == "true" ]]; then
                install_ide_plugin
            fi
            if [[ "${IOS_SETUP_OK}" != "true" ]]; then
                run_ios_setup
            else
                # Xcode already detected — report physical device tool status (no auto-install)
                ios_report_physical_device_tools
            fi
            ;;
    esac

    # CLI installation
    show_installation_progress 7
    if [[ "${INSTALL_DESKTOP_APP}" == "true" ]]; then
        if ! install_desktop_app; then
            log_warn "Desktop app installation failed; continuing with the remaining AutoMobile setup."
        fi
    fi
    if [[ -z "${POST_BUN_SETUP_PID}" && "${INSTALL_AUTOMOBILE_CLI}" == "true" ]]; then
        install_auto_mobile_cli
    fi

    # Claude Marketplace plugin installation
    if [[ "${INSTALL_CLAUDE_MARKETPLACE}" == "true" ]]; then
        install_claude_marketplace
    fi

    if [[ -n "${POST_BUN_SETUP_PID}" ]]; then
        finish_post_bun_setup
    else
        # Migrate stale daemon (restart if running an older version)
        migrate_stale_daemon

        # Daemon startup
        if [[ "${START_DAEMON}" == "true" ]]; then
            start_mcp_daemon
        fi
    fi

    finish_ios_runtime_probe

    # Write environment state for callers (e.g., hot-reload.sh)
    write_env_file

    # Print dry-run summary if applicable
    print_dry_run_summary

    echo ""
    if [[ "${DRY_RUN}" != "true" ]]; then
        if [[ "${CHANGES_MADE}" == "true" ]]; then
            log_info "Setup complete. Get started: https://kaeawc.github.io/auto-mobile/using/ux-exploration/"
        else
            log_info "No changes necessary"
        fi
    fi
}

# Run main unless the script is being sourced for testing (e.g. by BATS).
# Tests set INSTALL_SH_SOURCE_ONLY=true to load helper functions without
# executing the installer. The default (unset) path still runs main for both
# `bash install.sh` and piped `curl | bash` invocations.
if [[ "${INSTALL_SH_SOURCE_ONLY:-}" != "true" ]]; then
    trap 'cleanup_background_installer_work; echo ""; echo "Installation cancelled."; exit 130' INT TERM
    trap cleanup_background_installer_work EXIT
    main "$@"
fi
