#!/usr/bin/env bash
set -euo pipefail
# Intentional conditional calls propagate failures explicitly at their callers.
# shellcheck disable=SC2310
IFS=$'\n\t'

# Handle Ctrl-C (SIGINT) - exit immediately
trap 'echo ""; echo "Uninstall cancelled."; exit 130' INT

# Handle piped execution (SCRIPT_DIR used for potential future expansion)
# shellcheck disable=SC2034
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
    SCRIPT_DIR="$(pwd)"
fi

# Detect the Git project root for project-level configs. This matches the
# installer's project scope, including when either script runs from a nested
# directory in the repository.
PROJECT_ROOT="$(pwd)"
if command -v git >/dev/null 2>&1; then
    if git_root=$(git -C "${PROJECT_ROOT}" rev-parse --show-toplevel 2>/dev/null); then
        PROJECT_ROOT="${git_root}"
    fi
fi

# ============================================================================
# Global State
# ============================================================================
ALL=false
DRY_RUN=false
FORCE=false
RECORD_MODE=false
CHANGES_MADE=false

# Components to uninstall (set by interactive selection or --all)
UNINSTALL_MCP_CONFIGS=false
UNINSTALL_MARKETPLACE=false
UNINSTALL_CLI=false
UNINSTALL_DAEMON=false
UNINSTALL_DATA=false
UNINSTALL_DESKTOP_APP=false

# Detected components
MCP_CONFIGS_FOUND=()
MARKETPLACE_INSTALLED=false
MARKETPLACE_NAME=""
CLI_INSTALLED=false
DAEMON_RUNNING=false
DATA_DIR_EXISTS=false
DESKTOP_APP_INSTALLED=false
DESKTOP_APP_PATHS=()
DESKTOP_APP_PACKAGE=""
DESKTOP_APP_EXECUTABLES=()
DESKTOP_APP_BUNDLE_IDENTIFIER="dev.jasonpearson.automobile.desktop"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

# ============================================================================
# Utility Functions
# ============================================================================
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

desktop_app_is_root() {
    [[ "${EUID}" -eq 0 ]]
}

desktop_app_bundle_identifier() {
    plutil -extract CFBundleIdentifier raw "$1/Contents/Info.plist" 2>/dev/null
}

# Every privileged command status is returned to an explicit caller check.
# shellcheck disable=SC2310
run_desktop_app_privileged() {
    if desktop_app_is_root; then
        "$@"
    elif [[ "${1:-}" == "kill" || "${1:-}" == "ps" ]] && "$@" 2>/dev/null; then
        # Prefer the unprivileged operation for same-user processes; fall back
        # to sudo below when the process belongs to another user.
        return 0
    elif command_exists sudo; then
        sudo "$@"
    else
        log_error "Administrator privileges are required to remove the AutoMobile desktop app."
        return 1
    fi
}

log_info() {
    echo -e "${GREEN}INFO${RESET} $*"
}

log_warn() {
    echo -e "${YELLOW}WARN${RESET} $*"
}

log_error() {
    echo -e "${RED}ERROR${RESET} $*"
}

detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*)  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*) echo "linux" ;;
        *)       echo "unknown" ;;
    esac
}

# ============================================================================
# CLI Argument Parsing
# ============================================================================
show_help() {
    cat << 'EOF'
AutoMobile Uninstaller

Usage: ./scripts/uninstall.sh [OPTIONS]

Options:
  --all               Remove all AutoMobile components (non-interactive)
  --dry-run           Show what would be removed without making changes
  --record-mode       Auto-select all and run (for demo recording)
  --force             Skip confirmation prompts
  -h, --help          Show this help message

Components that can be removed:
  - MCP configurations from AI agents (Claude Desktop, Cursor, VS Code, etc.)
  - Claude Marketplace plugin
  - AutoMobile CLI (auto-mobile command)
  - MCP daemon process
  - AutoMobile data directory (~/.automobile)
  - AutoMobile desktop app

Examples:
  ./scripts/uninstall.sh              # Interactive mode
  ./scripts/uninstall.sh --all        # Remove everything
  ./scripts/uninstall.sh --all --dry-run  # Show what would be removed
  ./scripts/uninstall.sh --record-mode    # For demo recording

EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all|-a)
                ALL=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --record-mode)
                RECORD_MODE=true
                shift
                ;;
            --force|-f)
                FORCE=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# ============================================================================
# Gum Setup (reuse from interactive installer if available)
# ============================================================================
GUM_INSTALL_DIR="${HOME}/.automobile/bin"
GUM_BINARY="${GUM_INSTALL_DIR}/gum"

ensure_gum() {
    # Check if gum is available
    if command_exists gum; then
        return 0
    fi

    # Check bundled gum
    if [[ -x "${GUM_BINARY}" ]]; then
        export PATH="${GUM_INSTALL_DIR}:${PATH}"
        return 0
    fi

    # Fall back to basic prompts if gum not available
    return 1
}

# ============================================================================
# Detection Functions
# ============================================================================
detect_mcp_configs() {
    local os
    os=$(detect_os)
    MCP_CONFIGS_FOUND=()

    # Define all possible config locations
    local configs=()

    # Claude Code user and shared project config
    configs+=("Claude Code (User)|${HOME}/.claude.json|json")
    configs+=("Claude Code (Project)|${PROJECT_ROOT}/.mcp.json|json")

    # Claude Desktop
    if [[ "${os}" == "macos" ]]; then
        configs+=("Claude Desktop|${HOME}/Library/Application Support/Claude/claude_desktop_config.json|json")
    else
        configs+=("Claude Desktop|${HOME}/.config/Claude/claude_desktop_config.json|json")
    fi

    # Cursor
    configs+=("Cursor (Global)|${HOME}/.cursor/mcp.json|json")

    # Windsurf
    configs+=("Windsurf|${HOME}/.codeium/windsurf/mcp_config.json|json")

    # Codex user and project config
    configs+=("Codex (User)|${HOME}/.codex/config.toml|toml")
    configs+=("Codex (Project)|${PROJECT_ROOT}/.codex/config.toml|toml")

    # Firebender config locations remain removable for existing users.
    configs+=("Firebender (User)|${HOME}/.firebender/firebender.json|json")
    configs+=("Firebender (Project)|${PROJECT_ROOT}/firebender.json|json")

    # Goose
    configs+=("Goose|${HOME}/.config/goose/config.yaml|yaml")

    # Check each config for auto-mobile entries
    for entry in ${configs[@]+"${configs[@]}"}; do
        local name path format
        name=$(echo "${entry}" | cut -d'|' -f1)
        path=$(echo "${entry}" | cut -d'|' -f2)
        format=$(echo "${entry}" | cut -d'|' -f3)

        if [[ -f "${path}" ]]; then
            if config_has_automobile "${path}" "${format}"; then
                MCP_CONFIGS_FOUND+=("${entry}")
            fi
        fi
    done
}

# Package-tool absence is an expected detection miss.
# shellcheck disable=SC2310
detect_desktop_app() {
    DESKTOP_APP_INSTALLED=false
    DESKTOP_APP_PATHS=()
    DESKTOP_APP_PACKAGE=""
    DESKTOP_APP_EXECUTABLES=()

    local os
    os=$(detect_os)
    if [[ "${os}" == "macos" ]]; then
        local app_path
        for app_path in "/Applications/AutoMobile.app" "${HOME}/Applications/AutoMobile.app"; do
            if [[ -d "${app_path}" && -f "${app_path}/Contents/Info.plist" ]] \
                && [[ "$(desktop_app_bundle_identifier "${app_path}")" == "${DESKTOP_APP_BUNDLE_IDENTIFIER}" ]]; then
                DESKTOP_APP_PATHS+=("${app_path}")
                DESKTOP_APP_EXECUTABLES+=("${app_path}/Contents/MacOS/AutoMobile")
                DESKTOP_APP_INSTALLED=true
            fi
        done
        return 0
    fi

    # This is a capability predicate; absence means there is no package to inspect.
    # shellcheck disable=SC2310
    if [[ "${os}" == "linux" ]] && command_exists dpkg-query; then
        local package status
        for package in automobile auto-mobile; do
            status=$(dpkg-query -W -f='${db:Status-Status}' "${package}" 2>/dev/null || true)
            if [[ "${status}" == "installed" || "${status}" == "unpacked" || "${status}" == "half-configured" || "${status}" == "half-installed" ]]; then
                DESKTOP_APP_PACKAGE="${package}"
                DESKTOP_APP_INSTALLED=true
                local installed_path
                while IFS= read -r installed_path; do
                    if [[ "${installed_path}" == */bin/AutoMobile ]]; then
                        DESKTOP_APP_EXECUTABLES+=("${installed_path}")
                    fi
                done < <(dpkg-query -L "${package}" 2>/dev/null || true)
                return 0
            fi
        done
    fi
}

desktop_app_process_table() {
    ps -axo pid=,command=
}

# Only match commands whose executable is one of the exact paths discovered
# from the installed app bundle/package. This avoids broad pkill patterns that
# could terminate unrelated commands containing the AutoMobile name.
# The process-table failure is handled explicitly below.
# shellcheck disable=SC2310
desktop_app_process_pids() {
    local pid command_line executable process_table
    if ! process_table=$(desktop_app_process_table); then
        return 1
    fi
    while IFS=' ' read -r pid command_line; do
        [[ -n "${pid}" && -n "${command_line}" ]] || continue
        for executable in ${DESKTOP_APP_EXECUTABLES[@]+"${DESKTOP_APP_EXECUTABLES[@]}"}; do
            if [[ "${command_line}" == "${executable}" || "${command_line}" == "${executable}"\ * ]]; then
                printf '%s\n' "${pid}"
                break
            fi
        done
    done <<< "${process_table}"
}

desktop_app_termination_wait() {
    sleep 0.1
}

# Probe failures are represented by the documented return states.
# shellcheck disable=SC2310
desktop_app_pid_command() {
    if run_desktop_app_privileged ps -p "$1" -o command= 2>/dev/null; then
        return 0
    fi
    # A live PID whose command cannot be inspected is not safe to remove. A
    # failed liveness probe confirms that the process exited instead.
    if run_desktop_app_privileged kill -0 "$1" 2>/dev/null; then
        return 2
    fi
    return 1
}

# Return 0 while the PID is alive, 1 when it has exited, and 2 when its state
# cannot be verified (for example, because the privileged check was denied).
# Probe failures are represented by the documented return states.
# shellcheck disable=SC2310
desktop_app_pid_alive() {
    local pid="$1" executable recheck_executable process_listing command_status liveness_status recheck_listing recheck_status
    if process_listing=$(desktop_app_pid_command "${pid}"); then
        command_status=0
    else
        command_status=$?
    fi
    if [[ "${command_status}" -eq 2 ]]; then
        return 2
    elif [[ "${command_status}" -ne 0 ]]; then
        # A process can exit between the signal probe and ps lookup.
        return 1
    fi
    for executable in ${DESKTOP_APP_EXECUTABLES[@]+"${DESKTOP_APP_EXECUTABLES[@]}"}; do
        if [[ "${process_listing}" == "${executable}" || "${process_listing}" == "${executable} "* ]]; then
            if run_desktop_app_privileged kill -0 "${pid}" 2>/dev/null; then
                liveness_status=0
            else
                liveness_status=$?
            fi
            if [[ "${liveness_status}" -eq 0 ]]; then
                return 0
            fi
            # The PID can exit or be reused after its command was read. Re-read
            # the identity before treating a failed liveness probe as unsafe.
            if recheck_listing=$(desktop_app_pid_command "${pid}"); then
                recheck_status=0
            else
                recheck_status=$?
            fi
            if [[ "${recheck_status}" -eq 1 ]]; then
                return 1
            elif [[ "${recheck_status}" -eq 2 ]]; then
                return 2
            fi
            for recheck_executable in ${DESKTOP_APP_EXECUTABLES[@]+"${DESKTOP_APP_EXECUTABLES[@]}"}; do
                if [[ "${recheck_listing}" == "${recheck_executable}" || "${recheck_listing}" == "${recheck_executable} "* ]]; then
                    return 2
                fi
            done
            return 1
        fi
    done
    return 1
}

# Return 0 when every PID has stopped, 1 while one is still running, and 2
# when a PID cannot be verified safely.
# Probe failures are represented by the documented return states.
# shellcheck disable=SC2310
desktop_app_processes_stopped() {
    local pid pid_state
    for pid in "$@"; do
        if desktop_app_pid_alive "${pid}"; then
            pid_state=0
        else
            pid_state=$?
        fi
        if [[ "${pid_state}" -eq 0 ]]; then
            return 1
        elif [[ "${pid_state}" -eq 2 ]]; then
            return 2
        fi
    done
    return 0
}

# Return 0 when all PIDs exit, 1 after the bounded wait, and 2 when a PID can
# no longer be verified.
# Probe failures are returned explicitly to the caller.
# shellcheck disable=SC2310
wait_for_desktop_app_processes_to_stop() {
    local attempt=0 stopped_status
    while (( attempt < 20 )); do
        if desktop_app_processes_stopped "$@"; then
            return 0
        else
            stopped_status=$?
        fi
        [[ "${stopped_status}" -eq 2 ]] && return 2
        desktop_app_termination_wait
        ((attempt += 1))
    done
    return 1
}

# Every failed probe and signal is returned explicitly to the caller.
# shellcheck disable=SC2310
stop_desktop_app_processes() {
    local pids=()
    local pid pid_state wait_status process_pids
    if ! process_pids=$(desktop_app_process_pids); then
        log_error "Could not enumerate desktop app processes; refusing to remove the app."
        return 1
    fi
    while IFS= read -r pid; do
        [[ -n "${pid}" ]] && pids+=("${pid}")
    done <<< "${process_pids}"

    [[ ${#pids[@]} -gt 0 ]] || return 0

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would stop the AutoMobile desktop app"
        return 0
    fi

    log_info "Stopping AutoMobile desktop app..."
    for pid in ${pids[@]+"${pids[@]}"}; do
        if desktop_app_pid_alive "${pid}"; then
            pid_state=0
        else
            pid_state=$?
        fi
        if [[ "${pid_state}" -eq 1 ]]; then
            continue
        elif [[ "${pid_state}" -eq 2 ]]; then
            log_error "Could not verify desktop app process ${pid}; refusing to remove the app."
            return 1
        fi
        if ! run_desktop_app_privileged kill -TERM "${pid}" 2>/dev/null; then
            log_error "Could not signal desktop app process ${pid}; refusing to remove the app."
            return 1
        fi
    done

    if wait_for_desktop_app_processes_to_stop ${pids[@]+"${pids[@]}"}; then
        return 0
    else
        wait_status=$?
    fi
    if [[ "${wait_status}" -eq 2 ]]; then
        log_error "Could not verify a desktop app process; refusing to remove the app."
        return 1
    fi

    for pid in ${pids[@]+"${pids[@]}"}; do
        if desktop_app_pid_alive "${pid}"; then
            pid_state=0
        else
            pid_state=$?
        fi
        if [[ "${pid_state}" -eq 1 ]]; then
            continue
        elif [[ "${pid_state}" -eq 2 ]]; then
            log_error "Could not verify desktop app process ${pid}; refusing to remove the app."
            return 1
        fi
        # The explicit failure branch below intentionally handles this signal.
        # shellcheck disable=SC2310
        if ! run_desktop_app_privileged kill -KILL "${pid}" 2>/dev/null; then
            log_error "Could not terminate desktop app process ${pid}; refusing to remove the app."
            return 1
        fi
    done
    if wait_for_desktop_app_processes_to_stop ${pids[@]+"${pids[@]}"}; then
        return 0
    else
        wait_status=$?
    fi
    if [[ "${wait_status}" -eq 2 ]]; then
        log_error "Could not verify a desktop app process after SIGKILL; refusing to remove the app."
    else
        log_error "Desktop app processes remained after SIGKILL; refusing to remove the app."
    fi
    return 1
}

config_has_automobile() {
    local path="$1"
    local format="$2"

    # Look for actual MCP server entries, not project paths or comments
    case "${format}" in
        json)
            # Look for "auto-mobile" as a key followed by { (MCP server object)
            # This matches: "auto-mobile": { or "auto-mobile" : {
            # But not: "/path/to/auto-mobile/project": {
            grep -qE '"auto-mobile"\s*:\s*\{' "${path}" 2>/dev/null
            ;;
        toml)
            # Look for [mcp_servers.auto-mobile] section headers
            grep -qiE '^\[.*mcp.*auto-?mobile.*\]' "${path}" 2>/dev/null
            ;;
        yaml)
            # Look for auto-mobile: as a YAML key at root or under mcpServers
            grep -qE '^[[:space:]]*auto-mobile\s*:' "${path}" 2>/dev/null
            ;;
    esac
}

detect_marketplace() {
    if command_exists claude; then
        # Get list of marketplaces and find auto-mobile related ones
        local marketplace_output
        marketplace_output=$(claude plugin marketplace list 2>/dev/null || true)

        # Extract marketplace name (line starting with ❯ followed by the name)
        local name
        name=$(echo "${marketplace_output}" | grep -i 'auto-mobile' 2>/dev/null | grep '❯' 2>/dev/null | awk '{print $2}' | head -1 || true)

        if [[ -n "${name}" ]]; then
            MARKETPLACE_INSTALLED=true
            MARKETPLACE_NAME="${name}"
            return 0
        fi
    fi
    MARKETPLACE_INSTALLED=false
    MARKETPLACE_NAME=""
    return 0
}

detect_cli() {
    if command_exists auto-mobile; then
        CLI_INSTALLED=true
    else
        CLI_INSTALLED=false
    fi
    return 0
}

# Status 3 reserves ordinary error statuses 1/2 and blocks destructive follow-up.
DAEMON_MAY_BE_RUNNING=3

# Predicates run as statements, preserving the caller's errexit setting. This
# shared seam lets detection, stop and reload inspect failures without SC2310.
daemon_check() {
    local caller_options="$-"
    set +e
    "$@"
    DAEMON_CHECK_STATUS=$?
    if [[ "${caller_options}" == *e* ]]; then set -e; fi
    return 0
}

# Lexical POSIX path.resolve normalization only: never follow symlinks or cd.
# Empty overrides select the product default. NUL cannot exist in a Bash/env
# string; newline paths and explicit non-absolute launch cwd fail closed rather
# than lose bytes in command substitution or guess the daemon's launch cwd.
# TS currently preserves absolute overrides verbatim; normalized overrides with
# dots may therefore fail the exact record/argv match safely until TS agrees.
daemon_path() {
    local primary="$1" legacy="$2" suffix="$3" override launch_cwd part path
    local parts=()
    override="${!primary-${!legacy-}}"
    DAEMON_PATH=""
    if [[ -z "${override}" ]]; then
        override="/tmp/auto-mobile-daemon-$(id -u).${suffix}"
    elif [[ "${override}" != /* ]]; then
        launch_cwd="${AUTOMOBILE_DAEMON_LAUNCH_CWD:-${PWD}}"
        launch_cwd="${launch_cwd#"${launch_cwd%%[![:space:]]*}"}"
        launch_cwd="${launch_cwd%"${launch_cwd##*[![:space:]]}"}"
        [[ "${launch_cwd}" == /* ]] || return 1
        override="${launch_cwd}/${override}"
    fi
    [[ "${override}" != *$'\n'* && "${override}" != *$'\r'* ]] || return 1
    path="${override}"
    while [[ -n "${path}" ]]; do
        part="${path%%/*}"
        if [[ "${path}" == */* ]]; then path="${path#*/}"; else path=""; fi
        case "${part}" in
            ''|.) ;;
            ..) if [[ ${#parts[@]} -gt 0 ]]; then unset 'parts[${#parts[@]}-1]'; fi ;;
            *) parts+=("${part}") ;;
        esac
    done
    DAEMON_PATH=""
    for part in ${parts[@]+"${parts[@]}"}; do DAEMON_PATH+="/${part}"; done
    DAEMON_PATH="${DAEMON_PATH:-/}"
    printf '%s\n' "${DAEMON_PATH}"
}

# JSON is the product format. Without jq, accept only a strict legacy number;
# never guess at JSON. Unreadable/malformed records are retained for manual stop.
daemon_record_pid() {
    local record="$1" pid
    if command -v jq >/dev/null 2>&1; then
        pid=$(printf '%s' "${record}" | jq -er 'if type == "object" then .pid else . end | select(type == "number" and floor == .)' 2>/dev/null) || return 1
    else
        pid="${record}"
    fi
    [[ "${pid}" =~ ^[0-9]+$ && ${#pid} -le 10 ]] || return 1
    (( 10#${pid} > 1 && 10#${pid} <= 2147483647 )) || return 1
    DAEMON_RECORD_PID="$((10#${pid}))"
    printf '%s\n' "${DAEMON_RECORD_PID}"
}

# Mirror processTable.ts parseDaemonSocketPath: adjacent quoted/unquoted pieces
# form one token; quotes have no escape semantics in flattened ps argv.
# Manager always adds --daemon-socket-path=<encodeURIComponent(socketPath)>:
# default: --daemon-mode --daemon-socket-path=%2Ftmp%2Fauto-mobile-daemon-<uid>.sock
# override /a.sock: --daemon-mode --daemon-socket-path=%2Fa.sock
# No executable-name substring is ownership evidence.
daemon_command_tokens() {
    local text="$1" char quote="" token="" active=false index
    DAEMON_ARGV=()
    for ((index = 0; index < ${#text}; index++)); do
        char="${text:index:1}"
        if [[ -n "${quote}" ]]; then
            if [[ "${char}" == "${quote}" ]]; then quote=""; else token+="${char}"; fi
        elif [[ "${char}" == "'" || "${char}" == '"' ]]; then
            quote="${char}"; active=true
        elif [[ "${char}" == [[:space:]] ]]; then
            if [[ "${active}" == true ]]; then DAEMON_ARGV+=("${token}"); token=""; active=false; fi
        else
            token+="${char}"; active=true
        fi
    done
    [[ -z "${quote}" ]] || return 1
    if [[ "${active}" == true ]]; then DAEMON_ARGV+=("${token}"); fi
    return 0
}

# decodeURIComponent validates percent escapes and UTF-8 (including overlong,
# surrogate and out-of-range sequences). Bash cannot represent NUL in a path;
# reject it rather than silently truncating ownership evidence. No eval/printf %b
# of caller text: only validated hex bytes reach printf.
daemon_decode_socket_marker() {
    local value="$1" result="" char hex byte remaining=0 low=128 high=191 index
    local LC_ALL=C
    if [[ "${value}" == /* || "${value}" == \\* || "${value}" =~ ^[A-Za-z]:[/\\] ]]; then
        DAEMON_DECODED_MARKER="${value}"; printf '%s' "${value}"; return 0
    fi
    for ((index = 0; index < ${#value}; index++)); do
        char="${value:index:1}"
        if [[ "${char}" != % ]]; then
            (( remaining == 0 )) || return 1
            result+="${char}"; continue
        fi
        hex="${value:index+1:2}"
        [[ ${#hex} -eq 2 && "${hex}" != *[!0-9a-fA-F]* ]] || return 1
        byte=$((16#${hex})); index=$((index + 2))
        (( byte != 0 )) || return 1
        if (( remaining > 0 )); then
            (( byte >= low && byte <= high )) || return 1
            remaining=$((remaining - 1)); low=128; high=191
        elif (( byte < 128 )); then :
        elif (( byte >= 194 && byte <= 223 )); then remaining=1
        elif (( byte >= 224 && byte <= 239 )); then
            remaining=2
            if (( byte == 224 )); then low=160; elif (( byte == 237 )); then high=159; fi
        elif (( byte >= 240 && byte <= 244 )); then
            remaining=3
            if (( byte == 240 )); then low=144; elif (( byte == 244 )); then high=143; fi
        else return 1
        fi
        printf -v char '%b' "\\x${hex}"
        result+="${char}"
    done
    (( remaining == 0 )) || return 1
    DAEMON_DECODED_MARKER="${result}"
    printf '%s' "${result}"
}

# A JSON socketPath, when present, must match even for a dead recorded PID.
# Legacy numeric records and JSON without socketPath need argv ownership instead.
daemon_record_matches_namespace() {
    local record="$1" socket_path="$2"
    [[ "${record}" != *'{'* ]] && return 0
    command -v jq >/dev/null 2>&1 || return 1
    printf '%s' "${record}" | jq -e --arg socket "${socket_path}" \
        'type == "object" and ((has("socketPath") | not) or .socketPath == $socket)' >/dev/null 2>&1
}

daemon_pid_is_daemon() {
    local pid="$1" record="$2" socket_path="$3" pid_path="$4" command_line token marker="" markers=0 mode=false index
    [[ "$(cat "${pid_path}" 2>/dev/null)" == "${record}" ]] || return 1
    daemon_check daemon_record_matches_namespace "${record}" "${socket_path}"
    [[ "${DAEMON_CHECK_STATUS}" == 0 ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    command_line=$(ps -p "${pid}" -o command= 2>/dev/null) || return 1
    [[ -n "${command_line}" ]] || return 1
    local DAEMON_ARGV=()
    daemon_check daemon_command_tokens "${command_line}"
    [[ "${DAEMON_CHECK_STATUS}" == 0 ]] || return 1
    for ((index = 0; index < ${#DAEMON_ARGV[@]}; index++)); do
        token="${DAEMON_ARGV[index]}"
        [[ "${token}" != --daemon-mode ]] || mode=true
        if [[ "${token}" == --daemon-socket-path ]]; then
            markers=$((markers + 1)); marker="${DAEMON_ARGV[index+1]-}"
        elif [[ "${token}" == --daemon-socket-path=* ]]; then
            markers=$((markers + 1)); marker="${token#--daemon-socket-path=}"
        fi
    done
    [[ "${mode}" == true ]] || return 1
    if (( markers == 0 )); then
        # Only unmarked older launches may use the record + actual socket fallback.
        [[ -S "${socket_path}" ]] && command -v jq >/dev/null 2>&1 || return 1
        printf '%s' "${record}" | jq -e --arg socket "${socket_path}" \
            'type == "object" and .socketPath == $socket' >/dev/null 2>&1
    else
        (( markers == 1 )) && [[ -n "${marker}" && "${marker}" != --* ]] || return 1
        daemon_check daemon_decode_socket_marker "${marker}" >/dev/null
        [[ "${DAEMON_CHECK_STATUS}" == 0 ]] || return 1
        marker="${DAEMON_DECODED_MARKER}"
        [[ "${marker}" == "${socket_path}" ]]
    fi
}

# A failed kill probe alone could mean permission denied. Preserve the files
# if ps can still see the PID, even when we cannot signal it.
daemon_pid_present() {
    local command_line
    kill -0 "$1" 2>/dev/null && return 0
    command_line=$(ps -p "$1" -o command= 2>/dev/null) || return 1
    [[ -n "${command_line}" ]]
}

daemon_termination_wait() {
    sleep "${AUTOMOBILE_DAEMON_STOP_POLL_INTERVAL:-0.1}"
}

wait_for_daemon_to_stop() {
    local attempt attempts="${AUTOMOBILE_DAEMON_STOP_WAIT_ATTEMPTS:-100}"
    [[ "${attempts}" =~ ^[0-9]{1,3}$ ]] && (( 10#${attempts} <= 100 )) || attempts=100
    for ((attempt = 0; attempt < 10#${attempts}; attempt++)); do
        daemon_check daemon_pid_present "$1"
        if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then return 0; fi
        daemon_termination_wait
    done
    daemon_check daemon_pid_present "$1"
    [[ "${DAEMON_CHECK_STATUS}" != 0 ]]
}

detect_daemon() {
    local socket_path pid_path record pid
    DAEMON_RUNNING=false
    daemon_check daemon_path AUTOMOBILE_DAEMON_SOCKET_PATH AUTO_MOBILE_DAEMON_SOCKET_PATH sock >/dev/null
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then DAEMON_RUNNING=true; return 0; fi
    socket_path="${DAEMON_PATH}"
    daemon_check daemon_path AUTOMOBILE_DAEMON_PID_FILE_PATH AUTO_MOBILE_DAEMON_PID_FILE_PATH pid >/dev/null
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then DAEMON_RUNNING=true; return 0; fi
    pid_path="${DAEMON_PATH}"
    if [[ -S "${socket_path}" ]]; then
        DAEMON_RUNNING=true
    elif [[ -f "${pid_path}" ]] && record=$(cat "${pid_path}"); then
        # Substitution captures data; the status seam preserves predicate failures.
        daemon_check daemon_record_pid "${record}" >/dev/null
        if [[ "${DAEMON_CHECK_STATUS}" == 0 ]]; then
            pid="${DAEMON_RECORD_PID}"
            daemon_check daemon_pid_is_daemon "${pid}" "${record}" "${socket_path}" "${pid_path}"
            if [[ "${DAEMON_CHECK_STATUS}" == 0 ]]; then DAEMON_RUNNING=true; fi
        fi
    fi
    return 0
}

detect_data_dir() {
    if [[ -d "${HOME}/.automobile" ]]; then
        DATA_DIR_EXISTS=true
    else
        DATA_DIR_EXISTS=false
    fi
    return 0
}

# ============================================================================
# Removal Functions
# ============================================================================
remove_from_json_config() {
    local path="$1"
    local tmp_file="${path}.tmp"

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would remove auto-mobile entries from ${path}"
        return 0
    fi

    # Use jq if available for clean JSON manipulation
    if command_exists jq; then
        # Remove any key matching auto-mobile or automobile (case insensitive)
        jq 'walk(if type == "object" then with_entries(select(.key | test("auto-mobile|automobile"; "i") | not)) else . end)' "${path}" > "${tmp_file}" 2>/dev/null
        if [[ $? -eq 0 && -s "${tmp_file}" ]]; then
            mv "${tmp_file}" "${path}"
            return 0
        fi
        rm -f "${tmp_file}"
    fi

    # Fallback: use sed to remove lines containing auto-mobile
    # This is less precise but works without jq
    local backup="${path}.bak"
    cp "${path}" "${backup}"

    # Remove lines containing auto-mobile (case insensitive).
    # Prefer an in-place edit; fall back to a temp-file rewrite only when the
    # platform's sed lacks `-i` support. `${tmp_file}` is `${path}.tmp`, which
    # is also the backup suffix `sed -i.tmp` writes — so the in-place branch
    # must NOT then `mv` that backup back over the edited file, which reverted
    # the edit and left auto-mobile entries in place on jq-less machines (#3638).
    if sed -i.tmp -E '/"[^"]*[aA]uto-?[mM]obile[^"]*"/d' "${path}" 2>/dev/null; then
        rm -f "${path}.tmp" 2>/dev/null || true
    else
        sed -E '/"[^"]*[aA]uto-?[mM]obile[^"]*"/d' "${path}" > "${tmp_file}" && mv "${tmp_file}" "${path}"
    fi

    return 0
}

remove_from_toml_config() {
    local path="$1"

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would remove auto-mobile entries from ${path}"
        return 0
    fi

    local backup="${path}.bak"
    cp "${path}" "${backup}"

    # Remove TOML sections containing auto-mobile
    # This removes from [section.auto-mobile] to the next section or end of file
    local tmp_file="${path}.tmp"
    awk '
        /^\[.*[aA]uto-?[mM]obile.*\]/ { skip=1; next }
        /^\[/ { skip=0 }
        !skip { print }
    ' "${path}" > "${tmp_file}"
    mv "${tmp_file}" "${path}"
    return 0
}

remove_from_yaml_config() {
    local path="$1"

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would remove auto-mobile entries from ${path}"
        return 0
    fi

    # Use yq if available
    if command_exists yq; then
        local tmp_file="${path}.tmp"
        # Remove keys matching auto-mobile pattern
        yq 'del(.. | select(key | test("auto-mobile|automobile"; "i")))' "${path}" > "${tmp_file}" 2>/dev/null
        if [[ $? -eq 0 && -s "${tmp_file}" ]]; then
            mv "${tmp_file}" "${path}"
            return 0
        fi
        rm -f "${tmp_file}"
    fi

    # Fallback: use awk to remove YAML blocks
    local backup="${path}.bak"
    cp "${path}" "${backup}"

    local tmp_file="${path}.tmp"
    awk '
        /^[[:space:]]*[aA]uto-?[mM]obile:/ { skip=1; indent=match($0, /[^[:space:]]/)-1; next }
        skip && /^[[:space:]]*[^[:space:]]/ {
            current_indent=match($0, /[^[:space:]]/)-1
            if (current_indent <= indent) { skip=0 }
        }
        !skip { print }
    ' "${path}" > "${tmp_file}"
    mv "${tmp_file}" "${path}"
    return 0
}

remove_mcp_configs() {
    if [[ ${#MCP_CONFIGS_FOUND[@]} -eq 0 ]]; then
        log_info "No MCP configurations found to remove"
        return 0
    fi

    for entry in "${MCP_CONFIGS_FOUND[@]}"; do
        local name path format
        name=$(echo "${entry}" | cut -d'|' -f1)
        path=$(echo "${entry}" | cut -d'|' -f2)
        format=$(echo "${entry}" | cut -d'|' -f3)

        log_info "Removing auto-mobile from ${name}..."

        case "${format}" in
            json)
                remove_from_json_config "${path}"
                ;;
            toml)
                remove_from_toml_config "${path}"
                ;;
            yaml)
                remove_from_yaml_config "${path}"
                ;;
        esac

        if [[ "${DRY_RUN}" != "true" ]]; then
            CHANGES_MADE=true
        fi
    done
}

remove_marketplace() {
    if [[ "${MARKETPLACE_INSTALLED}" != "true" ]]; then
        log_info "Claude Marketplace not configured"
        return 0
    fi

    if [[ -z "${MARKETPLACE_NAME}" ]]; then
        log_warn "Could not determine marketplace name"
        return 1
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would run: claude plugin marketplace remove ${MARKETPLACE_NAME}"
        return 0
    fi

    log_info "Removing Claude Marketplace: ${MARKETPLACE_NAME}..."
    if claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null; then
        log_info "Claude Marketplace removed"
        CHANGES_MADE=true
    else
        log_warn "Failed to remove Claude Marketplace"
    fi
}

remove_cli() {
    if [[ "${CLI_INSTALLED}" != "true" ]]; then
        log_info "AutoMobile CLI not installed"
        return 0
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would remove AutoMobile CLI"
        if command_exists bun; then
            log_info "[DRY-RUN]   - bun remove -g @kaeawc/auto-mobile"
        fi
        if command_exists npm; then
            log_info "[DRY-RUN]   - npm uninstall -g @kaeawc/auto-mobile (legacy cleanup)"
        fi
        return 0
    fi

    log_info "Removing AutoMobile CLI..."

    if command_exists bun; then
        bun remove -g @kaeawc/auto-mobile 2>/dev/null || true
    fi

    # Also remove legacy npm global install (older versions used npm install -g)
    if command_exists npm; then
        npm uninstall -g @kaeawc/auto-mobile 2>/dev/null || true
    fi

    # Verify removal by checking if command still exists
    # Need to clear bash's command cache first
    hash -r 2>/dev/null || true

    if ! command -v auto-mobile >/dev/null 2>&1; then
        log_info "AutoMobile CLI removed"
        CHANGES_MADE=true
    else
        log_warn "AutoMobile CLI may still be installed at: $(command -v auto-mobile)"
    fi
}

stop_daemon() {
    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would stop MCP daemon"
        return 0
    fi

    local socket_path pid_path record pid current_record stop_status=0 term_status=0
    daemon_check daemon_path AUTOMOBILE_DAEMON_SOCKET_PATH AUTO_MOBILE_DAEMON_SOCKET_PATH sock >/dev/null
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
        log_warn "Unverifiable daemon socket path; use auto-mobile --daemon stop."
        return "${DAEMON_MAY_BE_RUNNING}"
    fi
    socket_path="${DAEMON_PATH}"
    daemon_check daemon_path AUTOMOBILE_DAEMON_PID_FILE_PATH AUTO_MOBILE_DAEMON_PID_FILE_PATH pid >/dev/null
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
        log_warn "Unverifiable daemon PID path; use auto-mobile --daemon stop."
        return "${DAEMON_MAY_BE_RUNNING}"
    fi
    pid_path="${DAEMON_PATH}"
    if [[ -f "${pid_path}" ]] && record=$(cat "${pid_path}") && [[ "${record}" == *'{'* || "${record}" == *'['* ]] && ! command -v jq >/dev/null 2>&1; then
        log_warn "jq is required to read the PID record at ${pid_path}; use auto-mobile --daemon stop. Leaving namespace files in place."
        return "${DAEMON_MAY_BE_RUNNING}"
    fi
    record=""
    if [[ -f "${pid_path}" ]]; then record=$(cat "${pid_path}") || record=""; fi
    daemon_check daemon_record_pid "${record}" >/dev/null
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
        if [[ -e "${socket_path}" || -S "${socket_path}" || -e "${pid_path}" ]]; then
            log_warn "A daemon may be running without a valid PID record; use auto-mobile --daemon stop. Leaving namespace files in place."
        else
            log_info "MCP daemon not running"
            return 0
        fi
        return "${DAEMON_MAY_BE_RUNNING}"
    fi

    pid="${DAEMON_RECORD_PID}"
    daemon_check daemon_record_matches_namespace "${record}" "${socket_path}"
    if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
        log_warn "Foreign daemon PID record at ${pid_path}; leaving files in place. Use auto-mobile --daemon stop."
        return "${DAEMON_MAY_BE_RUNNING}"
    fi
    daemon_check daemon_pid_present "${pid}"
    if [[ "${DAEMON_CHECK_STATUS}" == 0 ]]; then
        daemon_check daemon_pid_is_daemon "${pid}" "${record}" "${socket_path}" "${pid_path}"
        if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
            log_warn "PID record is stale or PID ${pid} is not an AutoMobile daemon; leaving files in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        fi
        log_info "Stopping MCP daemon (PID ${pid})..."
        daemon_check daemon_pid_is_daemon "${pid}" "${record}" "${socket_path}" "${pid_path}"
        if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then
            log_warn "Daemon identity changed; leaving files in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        fi
        kill -TERM "${pid}" 2>/dev/null && term_status=0 || term_status=$?
        stop_status="${term_status}"
        if [[ "${stop_status}" == 0 ]]; then
            daemon_check wait_for_daemon_to_stop "${pid}"
            stop_status="${DAEMON_CHECK_STATUS}"
        fi
        if [[ "${term_status}" == 0 && "${stop_status}" != 0 && "${1:-}" == reload ]]; then
            # Reload retains its existing escalation, but only for the exact
            # record/identity verified again immediately before signaling.
            daemon_check daemon_pid_is_daemon "${pid}" "${record}" "${socket_path}" "${pid_path}"
            if [[ "${DAEMON_CHECK_STATUS}" == 0 ]]; then
                log_warn "Namespace daemon did not stop within 10 seconds; sending KILL to PID ${pid}."
                kill -KILL "${pid}" 2>/dev/null && stop_status=0 || stop_status=$?
                if [[ "${stop_status}" == 0 ]]; then
                    daemon_check wait_for_daemon_to_stop "${pid}"
                    stop_status="${DAEMON_CHECK_STATUS}"
                fi
            fi
        fi
        if [[ "${stop_status}" != 0 ]]; then
            log_warn "MCP daemon did not stop within 10 seconds; leaving files in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        fi
    else
        log_info "MCP daemon not running; checking stale namespace files"
    fi
    # A successor can own the socket even after the recorded PID exits.
    if [[ -e "${socket_path}" || -S "${socket_path}" ]]; then
        local probe_status=2 probe_output=""
        if command -v nc >/dev/null 2>&1; then
            probe_output=$(LC_ALL=C nc -U -z -w 1 "${socket_path}" 2>&1) && probe_status=0 || probe_status=$?
            # A usage/permission/unsupported-option diagnostic is not refusal.
            if [[ "${probe_status}" == 1 && -n "${probe_output}" && "${probe_output}" != *"Connection refused"* ]]; then
                probe_status=2
            fi
        fi
        if [[ "${probe_status}" == 0 ]]; then
            log_warn "Namespace socket still accepts connections; leaving socket and PID record in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        elif [[ "${probe_status}" != 1 ]]; then
            # Missing/unsupported nc is inconclusive. Retire only our stale record.
            if [[ "$(cat "${pid_path}" 2>/dev/null)" == "${record}" ]]; then rm -f "${pid_path}"; fi
            log_warn "Cannot verify stale namespace socket; leaving socket in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        fi
    fi
    log_info "MCP daemon not running; removing stale namespace files"

    # Do not unlink a successor's record if it replaced ours during shutdown.
    if [[ -f "${pid_path}" ]]; then
        current_record=$(cat "${pid_path}") || { log_warn "Cannot read daemon PID record; use auto-mobile --daemon stop."; return "${DAEMON_MAY_BE_RUNNING}"; }
        if [[ "${current_record}" != "${record}" ]]; then
            log_warn "Daemon PID record changed; leaving namespace files in place. Use auto-mobile --daemon stop."
            return "${DAEMON_MAY_BE_RUNNING}"
        fi
    fi
    rm -f "${socket_path}" "${pid_path}" || { log_warn "Cannot remove namespace files; use auto-mobile --daemon stop."; return "${DAEMON_MAY_BE_RUNNING}"; }
    log_info "MCP daemon stopped"
    CHANGES_MADE=true
    return 0
}

remove_data_dir() {
    if [[ "${DATA_DIR_EXISTS}" != "true" ]]; then
        log_info "AutoMobile data directory not found"
        return 0
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would remove ${HOME}/.automobile"
        return 0
    fi

    log_info "Removing AutoMobile data directory..."
    rm -rf "${HOME}/.automobile"
    log_info "AutoMobile data directory removed"
    CHANGES_MADE=true
}

# Package-manager availability explicitly selects the removal command.
# shellcheck disable=SC2310
remove_desktop_app() {
    if [[ "${DESKTOP_APP_INSTALLED}" != "true" ]]; then
        log_info "AutoMobile desktop app not installed"
        return 0
    fi

    local os
    os=$(detect_os)
    if [[ "${DRY_RUN}" == "true" ]]; then
        if [[ "${os}" == "macos" ]]; then
            local app_path
            for app_path in ${DESKTOP_APP_PATHS[@]+"${DESKTOP_APP_PATHS[@]}"}; do
                log_info "[DRY-RUN] Would remove ${app_path}"
            done
        else
            log_info "[DRY-RUN] Would remove AutoMobile desktop package: ${DESKTOP_APP_PACKAGE}"
        fi
        return 0
    fi

    if [[ "${os}" == "macos" ]]; then
        local app_path
        for app_path in ${DESKTOP_APP_PATHS[@]+"${DESKTOP_APP_PATHS[@]}"}; do
            log_info "Removing AutoMobile desktop app from ${app_path}..."
            if [[ "${app_path}" == "/Applications/"* ]]; then
                if ! run_desktop_app_privileged rm -rf -- "${app_path}"; then
                    return 1
                fi
            else
                if ! rm -rf -- "${app_path}"; then
                    return 1
                fi
            fi
        done
    elif [[ "${os}" == "linux" ]]; then
        log_info "Removing AutoMobile desktop package: ${DESKTOP_APP_PACKAGE}..."
        if command_exists apt-get; then
            run_desktop_app_privileged apt-get remove -y "${DESKTOP_APP_PACKAGE}" || return 1
        elif command_exists dpkg; then
            run_desktop_app_privileged dpkg --remove "${DESKTOP_APP_PACKAGE}" || return 1
        else
            log_error "apt-get or dpkg is required to remove the AutoMobile desktop app package."
            return 1
        fi
    fi

    log_info "AutoMobile desktop app removed"
    CHANGES_MADE=true
}

# ============================================================================
# Interactive Selection
# ============================================================================
select_components() {
    if ! ensure_gum; then
        log_error "gum is required for interactive mode. Use --all for non-interactive uninstall."
        exit 1
    fi

    local options=()

    if [[ ${#MCP_CONFIGS_FOUND[@]} -gt 0 ]]; then
        local config_list=""
        for entry in "${MCP_CONFIGS_FOUND[@]}"; do
            local name
            name=$(echo "${entry}" | cut -d'|' -f1)
            config_list="${config_list}${name}, "
        done
        config_list="${config_list%, }"
        options+=("MCP Configurations (${config_list})")
    fi

    if [[ "${MARKETPLACE_INSTALLED}" == "true" ]]; then
        options+=("Claude Marketplace Plugin")
    fi

    if [[ "${CLI_INSTALLED}" == "true" ]]; then
        options+=("AutoMobile CLI")
    fi

    if [[ "${DAEMON_RUNNING}" == "true" ]]; then
        options+=("MCP Daemon (running)")
    fi

    if [[ "${DATA_DIR_EXISTS}" == "true" ]]; then
        options+=("AutoMobile Data (~/.automobile)")
    fi

    if [[ "${DESKTOP_APP_INSTALLED}" == "true" ]]; then
        options+=("AutoMobile Desktop App")
    fi

    # Add "Everything" option at the bottom if there are multiple components
    if [[ ${#options[@]} -gt 1 ]]; then
        options+=("Everything")
    fi

    if [[ ${#options[@]} -eq 0 ]]; then
        log_info "No AutoMobile components found to uninstall"
        exit 0
    fi

    echo ""
    gum style --bold "Select components to uninstall:"
    echo ""

    local selected
    selected=$(printf '%s\n' ${options[@]+"${options[@]}"} | gum filter --no-limit --placeholder "Type to filter, SPACE to select...") || true

    if [[ -z "${selected}" ]]; then
        log_info "No components selected"
        exit 0
    fi

    # Parse selection
    while IFS= read -r item; do
        case "${item}" in
            "MCP Configurations"*)
                UNINSTALL_MCP_CONFIGS=true
                ;;
            "Claude Marketplace Plugin")
                UNINSTALL_MARKETPLACE=true
                ;;
            "AutoMobile CLI")
                UNINSTALL_CLI=true
                ;;
            "MCP Daemon"*)
                UNINSTALL_DAEMON=true
                ;;
            "AutoMobile Data"*)
                UNINSTALL_DATA=true
                ;;
            "AutoMobile Desktop App")
                UNINSTALL_DESKTOP_APP=true
                ;;
            "Everything")
                UNINSTALL_MCP_CONFIGS=true
                UNINSTALL_MARKETPLACE=true
                UNINSTALL_CLI=true
                UNINSTALL_DAEMON=true
                UNINSTALL_DATA=true
                UNINSTALL_DESKTOP_APP=true
                ;;
        esac
    done <<< "${selected}"
}

# ============================================================================
# Confirmation
# ============================================================================
confirm_uninstall() {
    if [[ "${FORCE}" == "true" || "${RECORD_MODE}" == "true" ]]; then
        return 0
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        return 0
    fi

    echo ""
    gum style --foreground 214 --bold "The following will be removed:"
    echo ""

    if [[ "${UNINSTALL_MCP_CONFIGS}" == "true" ]]; then
        for entry in ${MCP_CONFIGS_FOUND[@]+"${MCP_CONFIGS_FOUND[@]}"}; do
            local name path
            name=$(echo "${entry}" | cut -d'|' -f1)
            path=$(echo "${entry}" | cut -d'|' -f2)
            echo "  - ${name}: ${path}"
        done
    fi

    if [[ "${UNINSTALL_MARKETPLACE}" == "true" ]]; then
        echo "  - Claude Marketplace Plugin"
    fi

    if [[ "${UNINSTALL_CLI}" == "true" ]]; then
        echo "  - AutoMobile CLI"
    fi

    if [[ "${UNINSTALL_DAEMON}" == "true" ]]; then
        echo "  - MCP Daemon"
    fi

    if [[ "${UNINSTALL_DATA}" == "true" ]]; then
        echo "  - AutoMobile Data (~/.automobile)"
    fi

    if [[ "${UNINSTALL_DESKTOP_APP}" == "true" ]]; then
        echo "  - AutoMobile Desktop App"
    fi

    echo ""

    if ! gum confirm "Proceed with uninstall?"; then
        log_info "Uninstall cancelled"
        exit 0
    fi
}

# ============================================================================
# Main
# ============================================================================
main() {
    parse_args "$@"

    echo ""
    if ensure_gum; then
        gum style --bold "AutoMobile Uninstaller"
    else
        echo -e "${BOLD}AutoMobile Uninstaller${RESET}"
    fi
    echo ""

    if [[ "${DRY_RUN}" == "true" ]]; then
        if ensure_gum; then
            gum style --foreground 214 --bold "DRY-RUN MODE: No changes will be made"
        else
            echo -e "${YELLOW}${BOLD}DRY-RUN MODE: No changes will be made${RESET}"
        fi
        echo ""
    elif [[ "${RECORD_MODE}" == "true" ]]; then
        if ensure_gum; then
            gum style --foreground 212 --bold "RECORD MODE: Auto-selecting all components"
        else
            echo -e "${YELLOW}${BOLD}RECORD MODE: Auto-selecting all components${RESET}"
        fi
        echo ""
    fi

    # Detect installed components
    log_info "Detecting installed components..."
    detect_mcp_configs
    detect_marketplace
    detect_cli
    detect_daemon
    detect_data_dir
    detect_desktop_app

    # Show what was found
    echo ""
    if [[ ${#MCP_CONFIGS_FOUND[@]} -gt 0 ]]; then
        log_info "Found ${#MCP_CONFIGS_FOUND[@]} MCP configuration(s) with auto-mobile"
    fi
    if [[ "${MARKETPLACE_INSTALLED}" == "true" ]]; then
        log_info "Found Claude Marketplace plugin"
    fi
    if [[ "${CLI_INSTALLED}" == "true" ]]; then
        log_info "Found AutoMobile CLI"
    fi
    if [[ "${DAEMON_RUNNING}" == "true" ]]; then
        log_info "Found running MCP daemon"
    fi
    if [[ "${DATA_DIR_EXISTS}" == "true" ]]; then
        log_info "Found AutoMobile data directory"
    fi
    if [[ "${DESKTOP_APP_INSTALLED}" == "true" ]]; then
        if [[ -n "${DESKTOP_APP_PACKAGE}" ]]; then
            log_info "Found AutoMobile desktop app package: ${DESKTOP_APP_PACKAGE}"
        else
            log_info "Found AutoMobile desktop app: ${DESKTOP_APP_PATHS[*]-}"
        fi
    fi

    # Check if anything was found
    local found_something=false
    if [[ ${#MCP_CONFIGS_FOUND[@]} -gt 0 ]] || \
       [[ "${MARKETPLACE_INSTALLED}" == "true" ]] || \
       [[ "${CLI_INSTALLED}" == "true" ]] || \
       [[ "${DAEMON_RUNNING}" == "true" ]] || \
       [[ "${DATA_DIR_EXISTS}" == "true" ]] || \
       [[ "${DESKTOP_APP_INSTALLED}" == "true" ]]; then
        found_something=true
    fi

    if [[ "${found_something}" != "true" ]]; then
        echo ""
        log_info "No AutoMobile components found to uninstall"
        exit 0
    fi

    # Select components
    if [[ "${ALL}" == "true" || "${RECORD_MODE}" == "true" ]]; then
        UNINSTALL_MCP_CONFIGS=true
        UNINSTALL_MARKETPLACE=true
        UNINSTALL_CLI=true
        UNINSTALL_DAEMON=true
        UNINSTALL_DATA=true
        UNINSTALL_DESKTOP_APP=true
    else
        select_components
    fi

    # Confirm
    if ensure_gum; then
        confirm_uninstall
    elif [[ "${FORCE}" != "true" && "${RECORD_MODE}" != "true" && "${DRY_RUN}" != "true" ]]; then
        echo ""
        echo -e "${YELLOW}${BOLD}Warning: About to remove AutoMobile components${RESET}"
        echo "Use --force to skip this prompt or --dry-run to preview changes"
        read -p "Continue? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Uninstall cancelled"
            exit 0
        fi
    fi

    # Perform uninstall
    echo ""
    if [[ "${UNINSTALL_DESKTOP_APP}" == "true" ]]; then
        if ! stop_desktop_app_processes; then
            log_error "Could not stop the AutoMobile desktop app; uninstall aborted."
            exit 1
        fi
    fi

    local daemon_stop_status=0
    if [[ "${UNINSTALL_DAEMON}" == "true" ]]; then
        daemon_check stop_daemon
        daemon_stop_status="${DAEMON_CHECK_STATUS}"
    fi

    # Config/marketplace entries do not own daemon data or installed binaries;
    # their removal is safe even when daemon shutdown cannot be confirmed.

    if [[ "${UNINSTALL_MCP_CONFIGS}" == "true" ]]; then
        if [[ "${daemon_stop_status}" == 0 ]]; then
            remove_mcp_configs
        else
            # Best-effort independent cleanup must still reach the blocked
            # summary and preserve the distinct daemon status on failure.
            daemon_check remove_mcp_configs
            if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then log_warn "MCP configuration cleanup failed."; fi
        fi
    fi

    if [[ "${UNINSTALL_MARKETPLACE}" == "true" ]]; then
        if [[ "${daemon_stop_status}" == 0 ]]; then
            remove_marketplace
        else
            daemon_check remove_marketplace
            if [[ "${DAEMON_CHECK_STATUS}" != 0 ]]; then log_warn "Marketplace cleanup failed."; fi
        fi
    fi

    if [[ "${UNINSTALL_CLI}" == "true" && "${daemon_stop_status}" == 0 ]]; then
        remove_cli
    fi

    if [[ "${UNINSTALL_DATA}" == "true" && "${daemon_stop_status}" == 0 ]]; then
        remove_data_dir
    fi

    if [[ "${UNINSTALL_DESKTOP_APP}" == "true" && "${daemon_stop_status}" == 0 ]]; then
        if ! remove_desktop_app; then
            log_error "Could not remove the AutoMobile desktop app; uninstall aborted."
            exit 1
        fi
    fi

    # Summary
    echo ""
    if [[ "${daemon_stop_status}" != 0 ]]; then
        local skipped=""
        if [[ "${UNINSTALL_CLI}" == true ]]; then skipped+=" remove_cli"; fi
        if [[ "${UNINSTALL_DATA}" == true ]]; then skipped+=" remove_data_dir"; fi
        if [[ "${UNINSTALL_DESKTOP_APP}" == true ]]; then skipped+=" remove_desktop_app"; fi
        log_error "Uninstall blocked: daemon shutdown unconfirmed; skipped:${skipped:- no destructive steps selected}. Run auto-mobile --daemon stop, then retry."
        return "${daemon_stop_status}"
    elif [[ "${DRY_RUN}" == "true" ]]; then
        log_info "Dry-run complete. No changes were made."
    elif [[ "${CHANGES_MADE}" == "true" ]]; then
        log_info "Uninstall complete"
    else
        log_info "No changes were necessary"
    fi
}

if [[ "${UNINSTALL_SH_SOURCE_ONLY:-}" != "true" ]]; then
    main "$@"
fi
