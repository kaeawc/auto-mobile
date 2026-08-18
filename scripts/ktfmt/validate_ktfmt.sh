#!/usr/bin/env bash
set -euo pipefail

INSTALL_KTFMT_WHEN_MISSING=${INSTALL_KTFMT_WHEN_MISSING:-false}
ONLY_TOUCHED_FILES=${ONLY_TOUCHED_FILES:-false}
ONLY_CHANGED_SINCE_SHA=${ONLY_CHANGED_SINCE_SHA:-""}

# Pinned ktfmt version -- single source of truth shared with install_ktfmt.sh so
# the installer and this validator's fingerprint gate can never drift apart.
# shellcheck source=scripts/ktfmt/ktfmt_version.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/ktfmt_version.sh"

# Shared VCS file-selection + install-when-missing helpers (issue #2823).
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/file-selection.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PROJECT_ROOT="$(pwd)"

# Check for required commands and install missing commands if allowed
echo -e "${YELLOW}Checking for required commands...${NC}"

# Check if ktfmt is installed (install-when-missing gate + re-verify).
if ! ensure_tool ktfmt "$PROJECT_ROOT/scripts/ktfmt/install_ktfmt.sh" "${INSTALL_KTFMT_WHEN_MISSING}"; then
    exit 1
fi

echo -e "${GREEN}ktfmt is available${NC}"

# Check for other required commands
for cmd in find xargs; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${RED}Required command '$cmd' is not available${NC}"
        exit 1
    fi
done
if vcs_uses_jj; then
    required_vcs_command="jj"
else
    required_vcs_command="git"
fi
if ! command -v "$required_vcs_command" >/dev/null 2>&1; then
    echo -e "${RED}Required command '$required_vcs_command' is not available${NC}"
    exit 1
fi

# Fingerprint gate (issue #2966): the scoped PR check only inspects a PR's
# changed files, so a ktfmt whose version differs from the pin would reformat
# *untouched* files this check never sees -- the PR passes, then main reddens
# post-merge when merge.yml reformats the whole tree. Assert the ktfmt on PATH
# is EXACTLY the pinned version before doing any per-file work, so version /
# style-config drift fails loudly here instead of silently scoped-passing.
# INSTALL_KTFMT_WHEN_MISSING only installs when ktfmt is *absent*, so an
# already-installed newer ktfmt would otherwise sail through. The shared gate
# (require_pinned_ktfmt_version, from ktfmt_version.sh) also subsumes the old
# --google-style probe: a matching version implies --google-style support.
require_pinned_ktfmt_version

# Start the timer
if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
    start_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
else
    start_time=$(date +%s)000  # Fallback to seconds * 1000
fi

echo -e "${YELLOW}Starting ktfmt validation...${NC}"

# Function to find all Kotlin files
find_all_kotlin_files() {
    # Scope hidden-file exclusion to the project itself. A generic `*/.*`
    # pattern also matches hidden parent directories such as
    # `/Users/jason/.codex/worktrees`, making a valid worktree look empty.
    find "$PROJECT_ROOT" -type f '(' -name "*.kt" -o -name "*.kts" ')' \
        -not -path "*/build/*" \
        -not -path "$PROJECT_ROOT/.*" \
        -not -path "*/node_modules/*" \
        -not -path "*/target/*" \
        -not -path "*/out/*" \
        -not -path "*/dist/*" \
        -not -path "*/.gradle/*" \
        | sort | uniq
}

# Per-tool file regex for the shared collectors (issue #2823).
KOTLIN_FILE_REGEX='^.*\.(kt|kts)$'

# Determine which files to process
declare -a files_to_process
errors=""

supports_mapfile=false
if builtin help mapfile >/dev/null 2>&1; then
    supports_mapfile=true
fi

load_files_to_process() {
    local mode="$1"
    shift

    local file_list
    file_list="$(mktemp)"

    if ! case "$mode" in
        changed)
            collect_changed_since_sha "$PROJECT_ROOT" "$1" "$KOTLIN_FILE_REGEX" > "$file_list"
            ;;
        touched)
            collect_touched_files "$PROJECT_ROOT" "$KOTLIN_FILE_REGEX" > "$file_list"
            ;;
        all)
            find_all_kotlin_files > "$file_list"
            ;;
        *)
            echo -e "${RED}Unknown Kotlin file collection mode: $mode${NC}" >&2
            return 1
            ;;
    esac
    then
        rm -f "$file_list"
        echo -e "${RED}Failed to collect Kotlin files${NC}" >&2
        exit 1
    fi

    if [[ "$supports_mapfile" == "true" ]]; then
        mapfile -t files_to_process < "$file_list"
    else
        while IFS= read -r file; do
            files_to_process+=("$file")
        done < "$file_list"
    fi

    rm -f "$file_list"
}

# If a base SHA was requested but does not resolve in this checkout (base branch
# force-pushed/rebased, or its commit was never fetched), fall back to a
# full-tree check instead of silently passing. collect_changed_since_sha also
# guards the SHA, and load_files_to_process checks producer failures in the main
# shell, but this up-front branch preserves the intended CI behavior: scoped
# mode degrades to a full-tree validation when a fetched base is unavailable.
if [[ -n "$ONLY_CHANGED_SINCE_SHA" ]] \
    && ! vcs_base_exists "$ONLY_CHANGED_SINCE_SHA"; then
    echo -e "${YELLOW}Base SHA '${ONLY_CHANGED_SINCE_SHA}' does not resolve; falling back to a full-tree ktfmt check.${NC}"
    ONLY_CHANGED_SINCE_SHA=""
    ONLY_TOUCHED_FILES=false
fi

# A changed formatter, its file-selection helper, or its CI runtime can change
# the result for files outside a PR's Kotlin diff. Run the full tree for those
# changes rather than relying on the post-merge backstop to discover drift.
if [[ -n "$ONLY_CHANGED_SINCE_SHA" ]] \
    && [[ -n "$(vcs_diff_since_merge_base "$ONLY_CHANGED_SINCE_SHA" \
        scripts/ktfmt \
        scripts/lib/file-selection.sh \
        scripts/lib/vcs-diff.sh \
        .github/workflows/pull_request.yml \
        .github/workflows/merge.yml)" ]]; then
    echo -e "${YELLOW}Ktfmt inputs changed since the base SHA; running a full-tree ktfmt check.${NC}"
    ONLY_CHANGED_SINCE_SHA=""
    ONLY_TOUCHED_FILES=false
fi

if [[ -n "$ONLY_CHANGED_SINCE_SHA" ]]; then
    echo -e "${YELLOW}Processing files changed since SHA: $ONLY_CHANGED_SINCE_SHA${NC}"
    load_files_to_process changed "$ONLY_CHANGED_SINCE_SHA"

elif [[ "${ONLY_TOUCHED_FILES}" == "true" ]]; then
    echo -e "${YELLOW}Processing only touched/staged files${NC}"
    load_files_to_process touched

else
    echo -e "${YELLOW}Processing all Kotlin files in the project${NC}"
    load_files_to_process all
fi

# Check if we have files to process
if [[ ${#files_to_process[@]} -eq 0 ]]; then
    echo -e "${GREEN}No Kotlin files to process${NC}"
    if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
        end_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
    else
        end_time=$(date +%s)000
    fi
    total_elapsed=$((end_time - start_time))
    echo "Total time elapsed: $total_elapsed ms."
    exit 0
fi

echo -e "${YELLOW}Found ${#files_to_process[@]} Kotlin file(s) to process${NC}"

# ktfmt writes formatted content back to its input files. Mirror the selected
# files under one temporary root so validation stays read-only, then format all
# copies in one JVM. The old one-file-at-a-time loop started a JVM per source
# file; on main that turned 680 files into a ten-minute job.
temp_dir=$(mktemp -d)
ktfmt_log=$(mktemp)
trap 'rm -rf "$temp_dir"; rm -f "$ktfmt_log"' EXIT

declare -a formatted_files
for file in "${files_to_process[@]}"; do
    relative_file="${file#"$PROJECT_ROOT"/}"
    formatted_file="$temp_dir/$relative_file"
    mkdir -p "$(dirname "$formatted_file")"
    cp "$file" "$formatted_file"
    formatted_files+=("$formatted_file")
done

# Passing all files in one invocation is safe for the current tree (680 paths)
# and removes almost all JVM startup cost; no parallel workers are needed.
echo -e "${YELLOW}Running ktfmt...${NC}"
if ! ktfmt --google-style "${formatted_files[@]}" > "$ktfmt_log" 2>&1; then
    errors="ktfmt failed to run (non-zero exit):\n$(<"$ktfmt_log")\n"
fi

for index in "${!files_to_process[@]}"; do
    if ! diff -q "${files_to_process[$index]}" "${formatted_files[$index]}" >/dev/null 2>&1; then
        errors="${errors}${files_to_process[$index]}: File needs formatting\n"
    fi
done

# Calculate total elapsed time
if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
    end_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
else
    end_time=$(date +%s)000
fi
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ -n "$errors" ]]; then
    echo -e "${RED}Formatting issues found in the following files:${NC}"
    echo -e "$errors"
    echo -e "${YELLOW}To fix these issues, run:${NC}"
    echo "cat <<EOF | xargs ktfmt --google-style"
    printf '%s\n' "${files_to_process[@]}"
    echo "EOF"
    echo -e "${RED}Total time elapsed: $total_elapsed ms.${NC}"
    exit 1
fi

echo -e "${GREEN}All Kotlin source files are properly formatted.${NC}"
echo "Total time elapsed: $total_elapsed ms."
exit 0
