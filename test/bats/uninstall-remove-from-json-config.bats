#!/usr/bin/env bats
#
# Tests for the jq-less JSON fallback in scripts/uninstall.sh
#
# Regression guard for #3638: the fallback reverted its own edit.
# `tmp_file="${path}.tmp"` is exactly the backup `sed -i.tmp` writes, and the
# `A || B && C` precedence ran `mv "${tmp_file}" "${path}"` after a *successful*
# in-place edit, restoring the original. So on machines without jq the
# uninstaller silently left auto-mobile entries in the MCP config.
#
# The fix guards the in-place edit with `if sed -i.tmp ...; then`. These are
# source-scan assertions (portable + deterministic across sed variants).

SCRIPT="scripts/uninstall.sh"

@test "in-place sed edit is not chained with '||' (the revert-prone form)" {
  # The buggy fallback was:
  #   sed -i.tmp -E '...' "${path}" || \
  #   sed -E '...' "${path}" > "${tmp_file}" && mv "${tmp_file}" "${path}"
  # i.e. an in-place `sed -i.tmp` followed by `||`. Fail if that reappears.
  run grep -nE 'sed +-i\.tmp.*\|\|' "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "in-place sed edit is guarded by 'if ... then'" {
  grep -qE 'if +sed +-i\.tmp' "$SCRIPT"
}

@test "the fallback still has a non-in-place sed branch (for seds lacking -i)" {
  # The else branch writes to a temp file then moves it into place.
  grep -qE 'mv +"\$\{tmp_file\}" +"\$\{path\}"' "$SCRIPT"
}
