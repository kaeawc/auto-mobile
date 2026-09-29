#!/usr/bin/env bash
# Check checked-in CtrlProxy Swift file references without XcodeGen or macOS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CTRL_PROXY_PROJECT_DIR="${CTRL_PROXY_PROJECT_DIR:-${PROJECT_ROOT}/ios/control-proxy}"

bun "${SCRIPT_DIR}/check-ctrl-proxy-project-sources.ts" "${CTRL_PROXY_PROJECT_DIR}"
