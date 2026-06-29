#!/usr/bin/env bats
#
# Tests for scripts/ios/validate-network-mock-debug-only.sh

SCRIPT="scripts/ios/validate-network-mock-debug-only.sh"

@test "network mock enforcement is guarded to debug builds" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS network mock enforcement is DEBUG-only."* ]]
}
