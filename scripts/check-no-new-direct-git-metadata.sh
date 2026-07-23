#!/usr/bin/env bash
set -euo pipefail

exec bun "$(dirname "$0")/check-no-new-direct-git-metadata.ts"
