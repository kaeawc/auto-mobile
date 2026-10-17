#!/usr/bin/env bash
set -euo pipefail

exec bun "$(dirname "$0")/check-tier-import-direction.ts" "$@"
