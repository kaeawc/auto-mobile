#!/usr/bin/env bash

INSTALL_SHFMT_WHEN_MISSING=${INSTALL_SHFMT_WHEN_MISSING:-false}
ONLY_TOUCHED_FILES=${ONLY_TOUCHED_FILES:-true}

# Shared git file-selection + install-when-missing helpers (issue #2823).
# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/file-selection.sh"
# shellcheck source=scripts/shellcheck/shfmt_version.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/shfmt_version.sh"

# The installer runs in a child process, so make its manual-install location
# visible when ensure_tool re-checks the binary in this parent process.
export PATH="$HOME/.local/bin:$PATH"

# Per-tool file regex for the shared collectors (issue #2823).
SHELL_FILE_REGEX='^.*\.sh$'

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if command exists
command_exists() {
  command -v "$1" > /dev/null 2>&1
}

PROJECT_ROOT="$(pwd)"

echo "PROJECT_ROOT: $PROJECT_ROOT"

# Check for required commands and install missing commands if allowed
echo -e "${YELLOW}Checking for required commands...${NC}"

# Check if shfmt is installed (install-when-missing gate + re-verify).
if ! ensure_tool shfmt "$PROJECT_ROOT/scripts/shellcheck/install_shfmt.sh" "${INSTALL_SHFMT_WHEN_MISSING}"; then
  exit 1
fi
if ! require_pinned_shfmt_version; then
  exit 1
fi

echo -e "${GREEN}shfmt is available${NC}"

# Check for other required commands
for cmd in find xargs git; do
  if ! command_exists "$cmd"; then
    echo -e "${RED}Required command '$cmd' is not available${NC}"
    exit 1
  fi
done

# Start the timer
if [[ -f "$PROJECT_ROOT/scripts/utils/get_timestamp.sh" ]]; then
  start_time=$(bash "$PROJECT_ROOT/scripts/utils/get_timestamp.sh")
else
  start_time=$(date +%s)000 # Fallback to seconds * 1000
fi

echo -e "${YELLOW}Starting shfmt formatting...${NC}"

# Function to find all shell script files
find_all_shell_files() {
  git ls-files --cached --others --exclude-standard -z \
    | grep -z '\.sh$' \
    | xargs -0 -I {} echo "$PROJECT_ROOT/{}" \
    | sort \
    | uniq
}

# Determine which files to process
declare -a files_to_process
errors=""

if [[ "${ONLY_TOUCHED_FILES}" == "true" ]]; then
  echo -e "${YELLOW}Processing only touched/staged files${NC}"

  # Get list of changed files
  touched_files=$(collect_touched_files "$PROJECT_ROOT" "$SHELL_FILE_REGEX")
  while IFS= read -r file; do
    [[ -n "$file" ]] && files_to_process+=("$file")
  done <<< "$touched_files"

else
  echo -e "${YELLOW}Processing all shell script files in the project${NC}"

  # Get all shell script files
  all_files=$(find_all_shell_files)
  while IFS= read -r file; do
    [[ -n "$file" ]] && files_to_process+=("$file")
  done <<< "$all_files"
fi

# Check if we have files to process
if [[ ${#files_to_process[@]} -eq 0 ]]; then
  echo -e "${GREEN}No shell script files to process${NC}"
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

echo -e "${YELLOW}Found ${#files_to_process[@]} shell script file(s) to process${NC}"

# Create temporary file for storing file list
temp_file=$(mktemp)
trap 'rm -f "$temp_file"' EXIT

# Write files to temporary file for xargs processing
printf '%s\n' "${files_to_process[@]}" > "$temp_file"

# Apply shfmt formatting with Google style
# -i 2: indent with 2 spaces
# -bn: binary ops like && and | may start a line
# -ci: switch cases will be indented
# -sr: redirect operators will be followed by a space
echo -e "${YELLOW}Applying shfmt formatting...${NC}"

if [[ -s "$temp_file" ]]; then
  # Apply shfmt formatting and capture output + exit status.
  shfmt_output=$(xargs shfmt -i 2 -bn -ci -sr -w 2>&1 < "$temp_file")
  shfmt_status=$?

  # A non-zero shfmt exit (e.g. an unparseable file → "reached EOF without
  # matching ...") is a failure even when the diagnostic lacks the keywords
  # below. The old keyword-only check silently skipped such files and still
  # git-added + reported success (#3643). Flag either signal.
  if [[ $shfmt_status -ne 0 ]] || echo "$shfmt_output" | grep -E "(error|Error|ERROR|failed|Failed|FAILED)" > /dev/null 2>&1; then
    errors="${shfmt_output:-shfmt exited with status $shfmt_status}"
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

echo -e "${GREEN}Shell scripts have been formatted successfully.${NC}"
echo "Total time elapsed: $total_elapsed ms."
exit 0
