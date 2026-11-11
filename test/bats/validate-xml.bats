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

# Runs the validator with the python3 backend in a scratch git repo holding $@
# as name=content pairs (#17930: CI needs no xmlstarlet apt install).
run_python_backend() {
  command -v python3 > /dev/null 2>&1 || skip "python3 not installed"
  local repo
  repo="$(mktemp -d)"
  git -C "$repo" init -q
  local pair
  for pair in "$@"; do
    printf '%s' "${pair#*=}" > "$repo/${pair%%=*}"
  done
  git -C "$repo" add .
  run env XML_VALIDATOR_BACKEND=python3 bash -c 'cd "$1" && bash "$2" 2>&1' _ "$repo" "$ABS_SCRIPT"
  rm -rf "$repo"
}

@test "python3 backend accepts well-formed XML" {
  run_python_backend 'ok.xml=<?xml version="1.0"?><a xmlns:t="urn:t"><t:b x="1"/></a>'
  [ "$status" -eq 0 ]
  [[ "$output" == *"No XML errors found"*"(python3)"* ]]
}

@test "python3 backend reports a malformed file with its position" {
  run_python_backend 'ok.xml=<a/>' 'bad.xml=<a><b></a>'
  [ "$status" -eq 1 ]
  [[ "$output" == *"bad.xml:1.8: mismatched tag"* ]]
  [[ "$output" != *"ok.xml"* ]]
}

@test "python3 is the fallback backend when no xmlstarlet is installed" {
  command -v python3 > /dev/null 2>&1 || skip "python3 not installed"
  ln -s "$(command -v python3)" "$BIN_DIR/python3"
  run env PATH="$BIN_DIR" bash -c 'command -v xml || command -v xmlstarlet'
  [ "$status" -ne 0 ]
  sed -n '/^select_backend()/,/^}/p' "$ABS_SCRIPT" > "$BIN_DIR/select-backend.sh"
  run env PATH="$BIN_DIR" bash -c 'source "$1"; select_backend' _ "$BIN_DIR/select-backend.sh"
  [ "$output" = "python3" ]
}
