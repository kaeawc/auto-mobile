#!/usr/bin/env bash
# Validate Dockerfile using hadolint

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS, so callers can branch on it without
# a function name in a condition.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

# Check if hadolint is installed
if ! command -v hadolint &>/dev/null; then
  echo -e "${YELLOW}hadolint not found. Installing...${NC}"

  # Detect OS and architecture
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "${ARCH}" in
    x86_64)
      ARCH="x86_64"
      ;;
    aarch64|arm64)
      ARCH="arm64"
      ;;
    *)
      echo -e "${RED}Unsupported architecture: ${ARCH}${NC}"
      exit 1
      ;;
  esac

  # hadolint ships no Darwin-arm64 build; Apple Silicon runs Darwin-x86_64
  # under Rosetta 2 (#3641).
  if [[ "${OS}" == "darwin" ]]; then
    ARCH="x86_64"
  fi

  # Pinned version and per-asset SHA-256, shared with install_hadolint.sh.
  # shellcheck source=scripts/hadolint/hadolint_version.sh
  source "$(dirname "${BASH_SOURCE[0]}")/../hadolint/hadolint_version.sh"
  # Cached, checksum-verified, backed-off release download (#17641).
  # shellcheck source=scripts/lib/release-download.sh
  source "$(dirname "${BASH_SOURCE[0]}")/../lib/release-download.sh"

  ASSET="hadolint-${OS^}-${ARCH}"
  DOWNLOAD_URL="$(hadolint_release_url "${ASSET}")"
  EXPECTED_SHA256="$(hadolint_release_sha256 "${ASSET}")"
  if [[ -z "${EXPECTED_SHA256}" ]]; then
    echo -e "${RED}No pinned checksum for hadolint ${HADOLINT_VERSION} asset ${ASSET}${NC}"
    exit 1
  fi

  echo "Fetching hadolint from: ${DOWNLOAD_URL}"

  run_capture_status release_fetch_pinned "${DOWNLOAD_URL}" "${EXPECTED_SHA256}" "${HOME}/bin/hadolint" "hadolint/${HADOLINT_VERSION}"
  if [[ "${RUN_STATUS}" -eq 0 ]]; then
    chmod +x "${HOME}/bin/hadolint"

    # Add to PATH if not already there
    if [[ ":${PATH}:" != *":${HOME}/bin:"* ]]; then
      export PATH="${HOME}/bin:${PATH}"
      echo -e "${YELLOW}Added ${HOME}/bin to PATH${NC}"
      echo -e "${YELLOW}Add 'export PATH=\"\${HOME}/bin:\${PATH}\"' to your shell profile${NC}"
    fi

    echo -e "${GREEN}hadolint installed successfully${NC}"
  else
    echo -e "${RED}Failed to download hadolint${NC}"
    exit 1
  fi
fi

# Validate Dockerfile
echo -e "${GREEN}Validating Dockerfile...${NC}"

if hadolint --config .hadolint.yaml Dockerfile; then
  echo -e "${GREEN}✓ Dockerfile validation passed${NC}"
  exit 0
else
  echo -e "${RED}✗ Dockerfile validation failed${NC}"
  exit 1
fi
