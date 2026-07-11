#!/usr/bin/env bats
#
# Tests for the mRotation parsing in scripts/await_idle.sh
#
# Regression guard for #3646: rotation was parsed with GNU BRE
#   sed -n 's/.*mRotation=\([0-9]\+\).*/\1/p'
# but this script targets macOS (it uses gdate/bc because BSD date lacks %3N),
# where the default sed is BSD and treats `\+` as a literal '+'. So
# `mRotation=0` never matched, current_rotation stayed empty, and
# wait_for_rotation always ran to timeout. The fix uses ERE (sed -E).

SCRIPT="scripts/await_idle.sh"

@test "mRotation extraction works under BSD sed" {
  # Pull the exact sed invocation the script uses for mRotation.
  local sed_cmd
  sed_cmd="$(grep -oE "sed -n?E? +'[^']*mRotation[^']*'" "$SCRIPT" | head -1)"
  [ -n "$sed_cmd" ]

  # Run that invocation under BSD sed (/usr/bin/sed on macOS; GNU on Linux —
  # the fixed ERE form must work under both). The old `\+` form yields empty
  # output under BSD sed.
  run bash -c "printf '    mRotation=3 mDisplayRotation=3\n' | ${sed_cmd/sed //usr/bin/sed }"
  [ "$status" -eq 0 ]
  [ "$output" = "3" ]
}
