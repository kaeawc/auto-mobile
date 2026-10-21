#!/usr/bin/env bash
# H has no input/observe tools: only a get-state heartbeat every five seconds.
set -euo pipefail
# shellcheck source=scripts/ci/linux-qualification/lib.sh
source "$(dirname "$0")/lib.sh"
printf 'heartbeat\n' > "$CYCLE_DIR/op-in-flight"
heartbeat
