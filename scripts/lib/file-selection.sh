#!/usr/bin/env bash
#
# Shared VCS file-selection boilerplate for the per-tool formatter/linter
# validate_<tool>.sh / apply_<tool>.sh scripts (issue #2823).
#
# Historically every formatter/linter re-declared the same three primitives:
#   * get_touched_files()          - working-tree files, regex-filtered
#   * get_changed_files_since_sha() - files changed vs a base SHA, regex-filtered
#   * the INSTALL_<TOOL>_WHEN_MISSING install-when-missing gate + re-verify
# The copies drifted. This file is the single source of truth (issue #2823).
# Only the per-tool file-extension/path regex and the tool binary differ, so the
# regex and PROJECT_ROOT are passed in as arguments rather than closed over.
#
# Sourcing convention mirrors scripts/local-dev/lib/common.sh and
# scripts/lib/tool-install.sh (issue #2822):
#   # shellcheck source=scripts/lib/file-selection.sh disable=SC1091
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/file-selection.sh"
#
# Exports:
#   collect_touched_files <project_root> <regex>
#       Emit absolute paths of modified files whose repo-relative path matches
#       <regex> and that still exist on disk. Git includes staged and working
#       changes; jj compares its working-copy commit with its parent.
#       Deduplicated + sorted. Returns non-zero when the VCS diff fails, so a
#       caller can distinguish "no matching files" from "VCS failed" (a producer
#       failure must never be mistaken for a clean tree).
#
#   collect_changed_since_sha <project_root> <sha> <regex>
#       Emit absolute paths of files changed from <sha> to the working copy whose
#       repo-relative path matches <regex> and that still exist on disk.
#       Deduplicated + sorted. Verifies the revision resolves; returns non-zero
#       (with a message on stderr) if it does not, or if the VCS diff fails.
#
#   ensure_tool <name> <installer_path> <install_when_missing>
#       The install-when-missing gate: if <name> is absent from PATH, either run
#       <installer_path> (when <install_when_missing> == "true") or fail with an
#       actionable message; then re-verify <name> is available. Returns non-zero
#       on any failure so the caller can `exit 1`.

# Colors. Guarded so re-sourcing (or a caller that already set them) does not
# clobber existing definitions. Match the escape style callers use with echo -e.
: "${RED:=\033[0;31m}"
: "${GREEN:=\033[0;32m}"
: "${YELLOW:=\033[1;33m}"
: "${NC:=\033[0m}"

# shellcheck disable=SC1091 # Resolved relative to the helper's location.
source "$(dirname "${BASH_SOURCE[0]}")/vcs-diff.sh"

# True if <cmd> is on PATH. Guarded so we don't redefine a caller's copy.
if ! declare -F command_exists > /dev/null 2>&1; then
  command_exists() {
    command -v "$1" > /dev/null 2>&1
  }
fi

# Filter a newline-delimited list of repo-relative paths on stdin: echo the
# absolute "$project_root/$file" for each entry that matches <regex> and exists.
_filter_matching_files() {
  local project_root="$1"
  local regex="$2"
  local file
  while read -r file; do
    if [[ "$file" =~ $regex ]] && [[ -f "$project_root/$file" ]]; then
      echo "$project_root/$file"
    fi
  done
}

collect_touched_files() {
  local project_root="$1"
  local regex="$2"

  # shellcheck disable=SC2119 # The current workspace determines touched files.
  vcs_touched_files \
    | _filter_matching_files "$project_root" "$regex" | sort | uniq
}

collect_changed_since_sha() {
  local project_root="$1"
  local sha="$2"
  local regex="$3"
  local changed_files

  # Verify the revision resolves before diffing so a bad base fails loudly here.
  if ! vcs_base_exists "$sha"; then
    echo -e "${RED}Revision '$sha' does not exist in the repository${NC}" >&2
    return 1
  fi

  if ! changed_files="$(vcs_changed_files_since_merge_base "$sha")"; then
    return 1
  fi

  printf '%s\n' "$changed_files" \
    | _filter_matching_files "$project_root" "$regex" | sort | uniq
}

ensure_tool() {
  local name="$1"
  local installer_path="$2"
  local install_when_missing="$3"

  if ! command_exists "$name"; then
    echo -e "${RED}${name} is not installed${NC}"
    if [[ "$install_when_missing" == "true" ]]; then
      echo -e "${YELLOW}Installing ${name}...${NC}"
      if [[ -f "$installer_path" ]]; then
        if ! bash "$installer_path"; then
          echo -e "${RED}Failed to install ${name}${NC}"
          return 1
        fi
      else
        echo -e "${RED}${name} installation script not found${NC}"
        return 1
      fi
    else
      local upper
      upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
      echo -e "${RED}${name} is required. Set INSTALL_${upper}_WHEN_MISSING=true to auto-install or install manually${NC}"
      return 1
    fi
  fi

  # Re-verify after any install attempt.
  if ! command_exists "$name"; then
    echo -e "${RED}${name} is still not available after installation attempt${NC}"
    return 1
  fi

  return 0
}
