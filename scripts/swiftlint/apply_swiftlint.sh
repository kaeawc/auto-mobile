#!/usr/bin/env bash

INSTALL_SWIFTLINT_WHEN_MISSING=${INSTALL_SWIFTLINT_WHEN_MISSING:-false}
ONLY_TOUCHED_FILES=${ONLY_TOUCHED_FILES:-true}

# Shared git file-selection + install-when-missing helpers (issue #2823).
# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/file-selection.sh"

# Per-tool file regex for the shared collectors (issue #2823).
SWIFT_FILE_REGEX='^ios/.*\.swift$'

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

# Check if swiftlint is installed (install-when-missing gate + re-verify).
if ! ensure_tool swiftlint "$PROJECT_ROOT/scripts/swiftlint/install_swiftlint.sh" "${INSTALL_SWIFTLINT_WHEN_MISSING}"; then
    exit 1
fi

echo -e "${GREEN}swiftlint is available ($(swiftlint version))${NC}"

# Check for other required commands
for cmd in find git; do
    if ! command_exists "$cmd"; then
        echo -e "${RED}Required command '$cmd' is not available${NC}"
        exit 1
    fi
done

# Start the timer
start_time=$(date +%s)

echo -e "${YELLOW}Starting SwiftLint auto-correction...${NC}"

# Function to find all Swift files in ios directory
find_all_swift_files() {
    find "$PROJECT_ROOT/ios" -type f -name "*.swift" \
        -not -path "*/build/*" \
        -not -path "*/.build/*" \
        -not -path "*/DerivedData/*" \
        -not -path "*/Pods/*" \
        -not -path "*/Carthage/*" \
        -not -path "*/.swiftpm/*" \
        -not -path "*/xcuserdata/*" \
        2>/dev/null | sort | uniq
}

# Determine which files to process
declare -a files_to_process

if [[ "${ONLY_TOUCHED_FILES}" == "true" ]]; then
    echo -e "${YELLOW}Processing only touched/staged files${NC}"
    while IFS= read -r file; do
        [[ -n "$file" ]] && files_to_process+=("$file")
    done < <(collect_touched_files "$PROJECT_ROOT" "$SWIFT_FILE_REGEX")

else
    echo -e "${YELLOW}Processing all Swift files in ios/ directory${NC}"
    while IFS= read -r file; do
        [[ -n "$file" ]] && files_to_process+=("$file")
    done < <(find_all_swift_files)
fi

# Check if we have files to process
if [[ ${#files_to_process[@]} -eq 0 ]]; then
    echo -e "${GREEN}No Swift files to process${NC}"
    end_time=$(date +%s)
    total_elapsed=$((end_time - start_time))
    echo "Total time elapsed: ${total_elapsed}s"
    exit 0
fi

echo -e "${YELLOW}Found ${#files_to_process[@]} Swift file(s) to auto-correct${NC}"

# Build swiftlint command
swiftlint_cmd="swiftlint lint --fix"

# Check if config file exists
if [[ -f "$PROJECT_ROOT/.swiftlint.yml" ]]; then
    swiftlint_cmd="$swiftlint_cmd --config $PROJECT_ROOT/.swiftlint.yml"
fi

# Apply swiftlint auto-corrections
echo -e "${YELLOW}Applying swiftlint auto-corrections...${NC}"

corrected_count=0
error_count=0

for file in "${files_to_process[@]}"; do
    if [[ -f "$file" ]]; then
        if $swiftlint_cmd "$file" 2>/dev/null; then
            ((corrected_count++))
        else
            echo -e "${RED}Error processing: $file${NC}"
            ((error_count++))
        fi
    fi
done

echo -e "${GREEN}Processed $corrected_count file(s)${NC}"

# Calculate total elapsed time
end_time=$(date +%s)
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ $error_count -gt 0 ]]; then
    echo -e "${RED}Errors encountered while processing $error_count file(s)${NC}"
    echo -e "${RED}Total time elapsed: ${total_elapsed}s${NC}"
    exit 1
fi

echo -e "${GREEN}SwiftLint auto-corrections applied successfully.${NC}"
echo -e "${YELLOW}Note: Not all issues can be auto-fixed. Run validate to check remaining issues.${NC}"
echo "Total time elapsed: ${total_elapsed}s"
exit 0
