#!/usr/bin/env bats
#
# Tests for scripts/xml/validate_xml.sh
#
# Regression guard for #3642: the tool-presence guard was
#   if [[ $(! command -v xml &>/dev/null) && $(! command -v xmlstarlet &>/dev/null) ]]
# which captures each command's stdout (redirected to /dev/null → empty), so
# `[[ "" && "" ]]` was always false and the guard never fired. With no XML tool
# installed the script must print the actionable "xmlstarlet missing" message
# and exit 1, not fall through to run a nonexistent command.

SCRIPT="scripts/xml/validate_xml.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  # A PATH containing only `bash` (needed to launch the script) so that
  # neither `xml` nor `xmlstarlet` is resolvable, regardless of the runner.
  # The fixed guard needs only shell builtins, so this is sufficient.
  BIN_DIR="$(mktemp -d)"
  ln -s "$(command -v bash)" "$BIN_DIR/bash"
}

teardown() {
  rm -rf "$BIN_DIR"
}

@test "fails with an actionable message when no XML tool is installed" {
  # Sanity: neither tool is resolvable on this PATH.
  run env PATH="$BIN_DIR" bash -c 'command -v xml || command -v xmlstarlet'
  [ "$status" -ne 0 ]

  run env PATH="$BIN_DIR" bash "$ABS_SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"xmlstarlet missing"* ]]
}
