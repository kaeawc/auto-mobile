#!/usr/bin/env bash
# Build the iOS simulator prototype apps that are not SwiftPM targets: the injectable agent dylib,
# the standalone prototype viewer and the ProtoViewer library app. Each is one `swiftc -O`
# whole-module compile of the shared renderer (the two apps once per simulator architecture), so
# together they are most of the Swift CI build time. scripts/ios/swift-build.sh runs all of them
# by default; the PR Swift CI job runs one app per matrix leg instead (#18429).
#
# Usage: scripts/ios/swift-build-prototype-apps.sh [all|prototype-agent|prototype-viewer|protoviewer]
#   (default: all). Outputs go to scratch/<app>-ci. Exits 0 without building when the
#   iphonesimulator SDK is missing, and non-zero when any selected build fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

ALL_APPS=(prototype-agent prototype-viewer protoviewer)

usage() {
  echo "Usage: $0 [all|prototype-agent|prototype-viewer|protoviewer]" >&2
}

selection="${1:-all}"
case "${selection}" in
  all) apps=("${ALL_APPS[@]}") ;;
  prototype-agent | prototype-viewer | protoviewer) apps=("${selection}") ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown prototype app: ${selection}" >&2
    usage
    exit 2
    ;;
esac

if ! xcrun --sdk iphonesimulator --show-sdk-path > /dev/null 2>&1; then
  echo -e "  ${BLUE}ℹ${NC} Skipping prototype apps (no iphonesimulator SDK)"
  exit 0
fi

build_app() {
  case "$1" in
    # The agent's UIKit sources are not a SwiftPM target (a macOS host build cannot import UIKit),
    # so compile the injectable simulator dylib; its core is tested by swift-test.sh.
    prototype-agent)
      "${SCRIPT_DIR}/prototype-agent-build.sh" "${PROJECT_ROOT}/scratch/prototype-agent-ci"
      ;;
    # The standalone viewer links the same renderer into its own simulator app content.
    prototype-viewer)
      "${SCRIPT_DIR}/prototype-viewer-build.sh" "${PROJECT_ROOT}/scratch/prototype-viewer-ci"
      ;;
    # The library app shares the renderer but owns its offline library and storage namespaces.
    protoviewer)
      "${SCRIPT_DIR}/protoviewer-build.sh" "${PROJECT_ROOT}/scratch/protoviewer-ci"
      ;;
  esac
}

failed=()
for app in "${apps[@]}"; do
  echo -e "${BLUE}Building iOS simulator ${app}...${NC}"
  SECONDS=0
  if build_app "${app}" 2>&1; then
    echo -e "  ${GREEN}✓${NC} ${app} built successfully (${SECONDS}s)"
  else
    echo -e "  ${RED}✗${NC} ${app} build failed (${SECONDS}s)"
    failed+=("${app}")
  fi
  echo ""
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo -e "${RED}Failed prototype apps: ${failed[*]}${NC}"
  exit 1
fi
