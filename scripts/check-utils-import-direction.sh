#!/usr/bin/env bash
set -euo pipefail

exec bun "$(dirname "$0")/check-utils-import-direction.ts" "$@"
