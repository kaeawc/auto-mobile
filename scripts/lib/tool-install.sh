#!/usr/bin/env bash
#
# Shared boilerplate for the per-tool installer scripts (install_<tool>.sh).
#
# Historically every installer (ktfmt, swiftformat, swiftlint, hadolint, lychee,
# shfmt, ...) re-declared the same ANSI-color block, command_exists(), detect_os()
# and (some of them) detect_arch(). The copies drifted -- e.g. the Swift
# installers dropped the Windows detect_os case and the arch helper -- so this
# file is the single source of truth for those primitives (issue #2822). Each
# installer sources it and keeps only its tool-specific config + install logic.
#
# Sourcing convention mirrors scripts/local-dev/lib/common.sh:
#   # shellcheck source=scripts/lib/tool-install.sh disable=SC1091
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/tool-install.sh"
#
# Exports:
#   RED / GREEN / YELLOW / NC  - ANSI color escapes for `echo -e`
#   command_exists <cmd>       - true if <cmd> is on PATH
#   detect_os                  - echoes macos|linux|windows|unknown
#   detect_arch                - echoes x86_64|arm64|armv7|386|unknown (normalized)
#   install_via_brew_or_manual - generic macOS brew-or-manual install helper

# shellcheck source=scripts/lib/shell-core.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/shell-core.sh"

# Colors for output. Guarded so re-sourcing (or a caller that already set them)
# does not clobber existing definitions.
: "${RED:=$'\033[0;31m'}"
: "${GREEN:=$'\033[0;32m'}"
: "${YELLOW:=$'\033[1;33m'}"
: "${NC:=$'\033[0m'}" # No Color

# Generic "use Homebrew if present, else fall back to a manual installer" helper
# for the macOS path. Consolidates the identical brew-or-manual skeleton that
# swiftformat/swiftlint/hadolint each hand-rolled.
#
#   install_via_brew_or_manual <display-name> <brew-formula> <manual-install-fn>
#
# The manual-install function is invoked by name when brew is absent or the
# `brew install` itself fails, and this helper returns that function's status.
install_via_brew_or_manual() {
  local display_name="$1"
  local brew_formula="$2"
  local manual_fn="$3"

  echo -e "${YELLOW}Installing ${display_name} on macOS...${NC}"

  if command_exists brew; then
    echo -e "${GREEN}Using Homebrew to install ${display_name}${NC}"
    if brew install "$brew_formula"; then
      return 0
    fi
    echo -e "${YELLOW}Homebrew installation failed. Falling back to manual installation...${NC}"
    "$manual_fn"
    return $?
  fi

  echo -e "${YELLOW}Homebrew not found. Falling back to manual installation...${NC}"
  "$manual_fn"
  return $?
}
