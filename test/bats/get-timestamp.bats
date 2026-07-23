#!/usr/bin/env bats

@test "get_timestamp emits a millisecond epoch when macOS lacks gdate" {
  run env OSTYPE=darwin /bin/bash scripts/utils/get_timestamp.sh

  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]{13}$ ]]
}
