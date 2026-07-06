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

# Colors for output. Guarded so re-sourcing (or a caller that already set them)
# does not clobber existing definitions.
: "${RED:=$'\033[0;31m'}"
: "${GREEN:=$'\033[0;32m'}"
: "${YELLOW:=$'\033[1;33m'}"
: "${NC:=$'\033[0m'}" # No Color

# Check if a command exists on PATH.
command_exists() {
  command -v "$1" > /dev/null 2>&1
}

# Detect the operating system family. Echoes one of: macos|linux|windows|unknown.
# The Windows (CYGWIN/MINGW/MSYS) case is included for every tool -- installers
# that don't ship a Windows binary simply won't route to it.
detect_os() {
  case "$(uname -s)" in
    Darwin*)
      echo "macos"
      ;;
    Linux*)
      echo "linux"
      ;;
    CYGWIN* | MINGW* | MSYS*)
      echo "windows"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

# Detect the CPU architecture, normalized to a canonical token. Echoes one of:
# x86_64|arm64|armv7|386|unknown. Callers map this canonical token to the
# per-release asset naming their tool uses (e.g. amd64, aarch64, x86_64).
detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)
      echo "x86_64"
      ;;
    aarch64 | arm64)
      echo "arm64"
      ;;
    armv7l)
      echo "armv7"
      ;;
    i386 | i686)
      echo "386"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

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
