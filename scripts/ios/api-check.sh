#!/usr/bin/env bash
# Checks that the iOS SDK public API surface matches the checked-in file.
# Exits non-zero if the API has changed.
#
# Usage: scripts/ios/api-check.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$REPO_ROOT/scripts/ios/api-dump.sh" --check
