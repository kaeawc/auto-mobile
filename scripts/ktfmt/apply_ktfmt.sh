#!/usr/bin/env bash

INSTALL_KTFMT_WHEN_MISSING=${INSTALL_KTFMT_WHEN_MISSING:-false}
ONLY_TOUCHED_FILES=${ONLY_TOUCHED_FILES:-true}

# Pinned ktfmt version + shared enforcement helpers -- single source of truth
# shared with install_ktfmt.sh and validate_ktfmt.sh.
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

echo "PROJECT_ROOT: $PROJECT_ROOT"

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

# Fingerprint gate (issue #2966): this script *mutates* files, so a ktfmt whose
# version differs from the pin would reformat the whole tree with the wrong
# formatter and could get committed -- the exact drift #2966 guards against, on
# the write path. Assert the pinned version before formatting anything. A
# matching version implies --google-style support, so this subsumes the old
# flag probe.
require_pinned_ktfmt_version

# Start the timer
if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
    start_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
else
    start_time=$(date +%s)000  # Fallback to seconds * 1000
fi

echo -e "${YELLOW}Starting ktfmt formatting...${NC}"

# Function to find all Kotlin files
find_all_kotlin_files() {
    find "$PROJECT_ROOT" -type f \( -name "*.kt" -o -name "*.kts" \) \
        -not -path "*/build/*" \
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

if [[ "${ONLY_TOUCHED_FILES}" == "true" ]]; then
    echo -e "${YELLOW}Processing only touched/staged files${NC}"

    # Get list of changed files
    touched_files=$(collect_touched_files "$PROJECT_ROOT" "$KOTLIN_FILE_REGEX")
    while IFS= read -r file; do
        [[ -n "$file" ]] && files_to_process+=("$file")
    done <<< "$touched_files"

else
    echo -e "${YELLOW}Processing all Kotlin files in the project${NC}"

    # Get all Kotlin files
    all_files=$(find_all_kotlin_files)
    while IFS= read -r file; do
        [[ -n "$file" ]] && files_to_process+=("$file")
    done <<< "$all_files"
fi

# Check if we have files to process
if [[ ${#files_to_process[@]} -eq 0 ]]; then
    echo -e "${GREEN}No Kotlin files to process${NC}"
    if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
        end_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
        total_elapsed=$((end_time - start_time))
    else
        end_time=$(date +%s)000
        total_elapsed=$((end_time - start_time))
    fi
    echo "Total time elapsed: $total_elapsed ms."
    exit 0
fi

echo -e "${YELLOW}Found ${#files_to_process[@]} Kotlin file(s) to process${NC}"

# Create temporary file for storing file list
temp_file=$(mktemp)
trap 'rm -f "$temp_file"' EXIT

# Write files to temporary file for xargs processing
printf '%s\n' "${files_to_process[@]}" > "$temp_file"

# Apply ktfmt formatting
echo -e "${YELLOW}Applying ktfmt formatting...${NC}"

if [[ -s "$temp_file" ]]; then
    # Apply ktfmt formatting with --google-style (2-space block + 2-space
    # continuation indent). This is a non-default style, so the flag is required.
    # Capture ktfmt's own exit status via PIPESTATUS[0] — without this, the
    # assignment only sees the trailing grep's status, masking a ktfmt/xargs
    # failure and letting the script stage unformatted files as "success".
    ktfmt_output=$(xargs ktfmt --google-style < "$temp_file" 2>&1 | grep -v "Done formatting" | grep -v "^$"; exit "${PIPESTATUS[0]}")
    ktfmt_status=$?

    # Treat a non-zero ktfmt/xargs run as a hard error; otherwise still scan the
    # output for error keywords (belt and suspenders).
    if [[ $ktfmt_status -ne 0 ]]; then
        errors="ktfmt exited with status ${ktfmt_status}:\n${ktfmt_output}"
    elif echo "$ktfmt_output" | grep -E "(error|Error|ERROR|failed|Failed|FAILED)" >/dev/null 2>&1; then
        errors="$ktfmt_output"
    fi
fi

# Count how many files were actually processed
processed_count=0
while IFS= read -r file; do
    if [[ -f "$file" ]]; then
        ((processed_count++))
    fi
done < "$temp_file"

echo -e "${GREEN}Processed $processed_count file(s)${NC}"

# Calculate total elapsed time
if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
    end_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
else
    end_time=$(date +%s)000
fi
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ -n "$errors" ]]; then
    echo -e "${RED}Errors encountered during formatting:${NC}"
    echo -e "$errors"
    echo -e "${RED}Total time elapsed: $total_elapsed ms.${NC}"
    exit 1
fi

# Stage the formatted files
if [[ ${#files_to_process[@]} -gt 0 ]]; then
    echo -e "${YELLOW}Staging formatted files...${NC}"
    printf '%s\n' "${files_to_process[@]}" | xargs git add
fi

echo -e "${GREEN}Kotlin source files have been formatted successfully.${NC}"
echo "Total time elapsed: $total_elapsed ms."
exit 0
