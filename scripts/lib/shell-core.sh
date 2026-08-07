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

# Ensure Bun dependencies are installed under <root> (default: current dir).
# No-op when node_modules/.bin/turbo already exists; otherwise installs from the
# committed lockfile. A fresh `git worktree` starts without node_modules (the
# gitignored dir is not copied), so validation entry points call this to
# self-heal instead of failing with a cryptic "turbo: command not found" (issue
# #5051). It installs only when deps are absent, so it is a no-op in CI where
# they are always present. The install runs in a subshell so the caller's
# working directory is left unchanged.
ensure_node_modules() {
  local root="${1:-$PWD}"
  if [ -x "$root/node_modules/.bin/turbo" ]; then
    return 0
  fi
  echo "node_modules missing in ${root} — installing Bun dependencies from bun.lock..."
  ( cd "$root" && bun install --frozen-lockfile )
}
