#!/usr/bin/env bash
set -euo pipefail

INSTALL_KTFMT_WHEN_MISSING=${INSTALL_KTFMT_WHEN_MISSING:-false}
ONLY_TOUCHED_FILES=${ONLY_TOUCHED_FILES:-false}
ONLY_CHANGED_SINCE_SHA=${ONLY_CHANGED_SINCE_SHA:-""}

# Pinned ktfmt version -- single source of truth shared with install_ktfmt.sh so
# the installer and this validator's fingerprint gate can never drift apart.
# shellcheck source=scripts/ktfmt/ktfmt_version.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/ktfmt_version.sh"

# Shared git file-selection + install-when-missing helpers (issue #2823).
# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/file-selection.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

PROJECT_ROOT="$(pwd)"

# Check for required commands and install missing commands if allowed
echo -e "${YELLOW}Checking for required commands...${NC}"

# Check if ktfmt is installed (install-when-missing gate + re-verify).
if ! ensure_tool ktfmt "$PROJECT_ROOT/scripts/ktfmt/install_ktfmt.sh" "${INSTALL_KTFMT_WHEN_MISSING}"; then
    exit 1
fi

echo -e "${GREEN}ktfmt is available${NC}"

# Check for other required commands
for cmd in find xargs git; do
    if ! command_exists "$cmd"; then
        echo -e "${RED}Required command '$cmd' is not available${NC}"
        exit 1
    fi
done

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
    find "$PROJECT_ROOT" -type f '(' -name "*.kt" -o -name "*.kts" ')' \
        -not -path "*/build/*" \
        -not -path "*/.*" \
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
    && ! git rev-parse --verify -q "${ONLY_CHANGED_SINCE_SHA}^{commit}" >/dev/null 2>&1; then
    echo -e "${YELLOW}Base SHA '${ONLY_CHANGED_SINCE_SHA}' does not resolve; falling back to a full-tree ktfmt check.${NC}"
    ONLY_CHANGED_SINCE_SHA=""
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

# Create temporary file for storing file list
temp_file=$(mktemp)
trap 'rm -f "$temp_file"' EXIT

# Write files to temporary file for xargs processing
printf '%s\n' "${files_to_process[@]}" > "$temp_file"

# Run ktfmt with xargs and capture output
echo -e "${YELLOW}Running ktfmt...${NC}"

if [[ -s "$temp_file" ]]; then
    temp_dir=$(mktemp -d)
    trap 'rm -rf "$temp_dir"' EXIT

    while IFS= read -r file; do
        if [[ -f "$file" ]]; then
            # Preserve the file name for actionable output while formatting an
            # isolated copy so validation never mutates the working tree.
            temp_file_path="$temp_dir/$(basename "$file")"
            cp "$file" "$temp_file_path"

            # Format the temp file with --google-style (2-space block and
            # 2-space continuation indent — the style the tree is formatted
            # with). Treat a non-zero ktfmt exit as a failure rather than
            # silently diffing an unformatted copy (which would falsely report
            # the file as clean).
            if ! ktfmt --google-style "$temp_file_path" >/dev/null 2>&1; then
                errors="${errors}${file}: ktfmt failed to run (non-zero exit)\n"
                continue
            fi

            # Compare original and formatted versions.
            if ! diff -q "$file" "$temp_file_path" >/dev/null 2>&1; then
                errors="${errors}${file}: File needs formatting\n"
            fi
        fi
    done < "$temp_file"
else
    echo -e "${GREEN}No files to process${NC}"
fi

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
