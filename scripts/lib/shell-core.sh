#!/usr/bin/env bash
# Shared Bash primitives. Keep this file small, side-effect free, and safe to
# source from validation/install scripts; tool-specific behavior belongs with
# its caller.

command_exists() {
  command -v "$1" > /dev/null 2>&1
}

detect_os() {
  case "$(uname -s)" in
    Darwin*) printf '%s\n' "macos" ;;
    Linux*) printf '%s\n' "linux" ;;
    CYGWIN* | MINGW* | MSYS*) printf '%s\n' "windows" ;;
    *) printf '%s\n' "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s\n' "x86_64" ;;
    aarch64 | arm64) printf '%s\n' "arm64" ;;
    armv7l) printf '%s\n' "armv7" ;;
    i386 | i686) printf '%s\n' "386" ;;
    *) printf '%s\n' "unknown" ;;
  esac
}
